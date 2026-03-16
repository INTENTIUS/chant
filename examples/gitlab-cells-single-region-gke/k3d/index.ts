// k3d smoke test K8s manifests.
// Build: npm run build:k3d  →  k3d.yaml
// Run:   npm run test:local  →  scripts/k3d-smoke.sh
//
// Resources in this file replace/supplement the production system manifests
// for local routing validation:
//   - cell-router: real OpenResty image, built locally (cell-router:local)
//   - topology-service: real Go image, built locally (topology-service:local)
//     No real DB needed — falls back to "alpha" for unknown org slugs.
//   - mock cells: nginx stubs on port 8181, named to match cell-registry.json
//   - cell-router Service: NodePort 30080 → accessible at localhost:8080

import { Deployment, Service, ConfigMap, Ingress } from "@intentius/chant-lexicon-k8s";
import { cells, shared } from "../src/config";
import { routingRulesConfigMap } from "../src/system/routing-rules";
import { createMockCell } from "./mock-cell";
import { CELL_ROUTER_IMAGE, TOPOLOGY_SERVICE_IMAGE, SYSTEM_NS, NODE_PORT } from "./cluster";

// --- Routing rules ConfigMap (same as production) ---
// The routing-rules.json and cell-registry.json inside this ConfigMap reference
// mock cell service names (gitlab-cell-<name>-webservice-default) that the mock
// cells implement exactly. No changes needed.
export { routingRulesConfigMap };

// --- Mock topology service ---
// Uses the real topology-service image but with a bogus DB config.
// The service starts immediately (DB connect is async); with no DB it returns
// {"cell":"alpha","cell_id":1} for every org_slug lookup — perfect for smoke testing.
export const k3dTopologyConfig = new ConfigMap({
  metadata: { name: "topology-service-k3d", namespace: SYSTEM_NS },
  data: {
    "config.yaml": `
database:
  host: 127.0.0.1
  port: 5432
  name: topology_smoke
  user: unused
  sslmode: disable
server:
  port: 8080
`,
  },
});

// DB_PASSWORD sourced from a K8s secret even in k3d — the secret contains a
// dummy value created by k3d-smoke.sh. This satisfies lint rules while keeping
// the smoke test self-contained.
export const k3dTopologyDeployment = new Deployment({
  metadata: {
    name: "topology-service",
    namespace: SYSTEM_NS,
    labels: { "app.kubernetes.io/name": "topology-service" },
  },
  spec: {
    replicas: 1,
    selector: { matchLabels: { "app.kubernetes.io/name": "topology-service" } },
    template: {
      metadata: { labels: { "app.kubernetes.io/name": "topology-service" } },
      spec: {
        containers: [{
          name: "topology-service",
          image: TOPOLOGY_SERVICE_IMAGE,
          // "Never" because the image is loaded via `k3d image import`, not pushed to a registry.
          imagePullPolicy: "Never",
          ports: [{ name: "http", containerPort: 8080 }],
          resources: {
            requests: { cpu: "20m", memory: "32Mi" },
            limits: { cpu: "200m", memory: "128Mi" },
          },
          env: [{
            name: "DB_PASSWORD",
            // Secret created by k3d-smoke.sh before `kubectl apply`. Value is a dummy —
            // the topology service will attempt to connect, fail, and fall back to
            // returning "alpha" for all org_slug lookups (no DB needed for smoke tests).
            valueFrom: { secretKeyRef: { name: "topology-smoke-db-secret", key: "password" } },
          }],
          livenessProbe: { httpGet: { path: "/healthz", port: 8080 }, initialDelaySeconds: 3, periodSeconds: 10 },
          readinessProbe: { httpGet: { path: "/healthz", port: 8080 }, initialDelaySeconds: 2, periodSeconds: 5 },
          volumeMounts: [{ name: "config", mountPath: "/etc/topology-service" }],
        }],
        volumes: [{ name: "config", configMap: { name: "topology-service-k3d" } }],
      },
    },
  },
});

export const k3dTopologyService = new Service({
  metadata: {
    name: "topology-service",
    namespace: SYSTEM_NS,
    labels: { "app.kubernetes.io/name": "topology-service" },
  },
  spec: {
    selector: { "app.kubernetes.io/name": "topology-service" },
    ports: [{ name: "http", port: 8080, targetPort: "http" }],
  },
});

// --- Cell Router (real image, NodePort for direct access) ---
export const k3dCellRouterDeployment = new Deployment({
  metadata: {
    name: "cell-router",
    namespace: SYSTEM_NS,
    labels: { "app.kubernetes.io/name": "cell-router" },
  },
  spec: {
    replicas: 1,
    selector: { matchLabels: { "app.kubernetes.io/name": "cell-router" } },
    template: {
      metadata: { labels: { "app.kubernetes.io/name": "cell-router" } },
      spec: {
        containers: [{
          name: "cell-router",
          image: CELL_ROUTER_IMAGE,
          // "Never" because the image is loaded via `k3d image import`.
          imagePullPolicy: "Never",
          ports: [{ name: "http", containerPort: 8080 }],
          resources: {
            requests: { cpu: "20m", memory: "32Mi" },
            limits: { cpu: "500m", memory: "128Mi" },
          },
          livenessProbe: { httpGet: { path: "/healthz", port: 8080 }, initialDelaySeconds: 3, periodSeconds: 10 },
          readinessProbe: { httpGet: { path: "/healthz", port: 8080 }, initialDelaySeconds: 2, periodSeconds: 5 },
          volumeMounts: [{ name: "routing-rules", mountPath: "/etc/cell-router" }],
        }],
        volumes: [{ name: "routing-rules", configMap: { name: "cell-router-rules" } }],
      },
    },
  },
});

// NodePort service: k3d maps host:8080 → node:30080 → cell-router pod:8080.
// No nginx ingress or load balancer needed for the smoke test.
export const k3dCellRouterService = new Service({
  metadata: {
    name: "cell-router",
    namespace: SYSTEM_NS,
    labels: { "app.kubernetes.io/name": "cell-router" },
  },
  spec: {
    type: "NodePort",
    selector: { "app.kubernetes.io/name": "cell-router" },
    ports: [{ name: "http", port: 8080, targetPort: "http", nodePort: NODE_PORT }],
  },
});

// --- Nginx ingress for cell-router (mirrors production Ingress) ---
// Routes Host-header-based requests through ingress-nginx → cell-router.
// ingress-nginx is installed by k3d-smoke.sh with NodePort 30081 (localhost:8081).
//
// This lets k3d-validate.sh reproduce the production nginx wildcard subdomain
// routing and catch the bug where *.domain only matches one subdomain level
// (e.g. *.gitlab.example.com does NOT match gitlab.alpha.gitlab.example.com).
const cellRouterBackend = {
  paths: [{
    path: "/",
    pathType: "Prefix" as const,
    backend: { service: { name: "cell-router", port: { number: 8080 } } },
  }],
};

export const k3dCellRouterIngress = new Ingress({
  metadata: {
    name: "cell-router",
    namespace: SYSTEM_NS,
    annotations: {
      "kubernetes.io/ingress.class": "nginx",
    },
  },
  spec: {
    ingressClassName: "nginx",
    rules: [
      // Top-level wildcard: catches *.gitlab.example.com (one subdomain level)
      { host: `*.${shared.domain}`, http: cellRouterBackend },
      // Per-cell wildcard: catches gitlab.<cell>.gitlab.example.com (two levels).
      // Required because nginx wildcard rules only match a single subdomain level —
      // without these rules, cell URLs like gitlab.alpha.gitlab.example.com get 404.
      ...cells.map(cell => ({
        host: `*.${cell.name}.${shared.domain}`,
        http: cellRouterBackend,
      })),
    ],
  },
});

// --- Mock cells ---
const _mockCells = cells.map(c => createMockCell(c.name));
export const mockCellNginxConfigs = _mockCells.map(c => c.nginxConfig);
export const mockCellDeployments = _mockCells.map(c => c.deployment);
export const mockCellServices = _mockCells.map(c => c.service);
