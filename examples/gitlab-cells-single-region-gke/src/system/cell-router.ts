import { Deployment, Service, NetworkPolicy, Ingress } from "@intentius/chant-lexicon-k8s";
import { createResource } from "@intentius/chant/runtime";
import { cells, shared } from "../config";

import { routingRulesConfigMap } from "./routing-rules";

const HorizontalPodAutoscaler = createResource("K8s::HorizontalPodAutoscaler", "k8s", {});

const labels = {
  "app.kubernetes.io/name": "cell-router",
  "app.kubernetes.io/part-of": "system",
};

// Deployment: models the routing layer GitLab implements as Cloudflare Workers.
// In this self-managed demo it runs as a K8s Deployment in the system namespace.
// Reads routing-rules.json and cell-registry.json from ConfigMap, evaluates
// session token, routable token, and path rules in priority order, then proxies
// to the winning cell's internal K8s service URL.
export const cellRouterDeployment = new Deployment({
  metadata: { name: "cell-router", namespace: "system", labels },
  spec: {
    replicas: 2,
    selector: { matchLabels: { "app.kubernetes.io/name": "cell-router" } },
    template: {
      metadata: { labels: { "app.kubernetes.io/name": "cell-router" } },
      spec: {
        containers: [{
          name: "cell-router",
          // OpenResty (nginx + LuaJIT) reads routing-rules.json, cell-registry.json,
          // and router-config.json from the ConfigMap and routes requests by:
          //   1. _gitlab_session cookie cell prefix (stateless)
          //   2. glrt-cell_<id>_ routable token prefix (stateless)
          //   3. Topology Service org-slug lookup (path fallback)
          image: shared.cellRouterImage,
          ports: [{ name: "http", containerPort: 8080 }],
          resources: {
            requests: { cpu: "250m", memory: "128Mi" },
            limits: { cpu: "1", memory: "256Mi" },
          },
          livenessProbe: { httpGet: { path: "/healthz", port: 8080 }, initialDelaySeconds: 5, periodSeconds: 10 },
          readinessProbe: { httpGet: { path: "/healthz", port: 8080 }, initialDelaySeconds: 3, periodSeconds: 5 },
          volumeMounts: [{ name: "routing-rules", mountPath: "/etc/cell-router" }],
        }],
        volumes: [{ name: "routing-rules", configMap: { name: "cell-router-rules" } }],
      },
    },
  },
});

export const cellRouterHpa = new HorizontalPodAutoscaler({
  metadata: { name: "cell-router", namespace: "system" },
  spec: {
    scaleTargetRef: { apiVersion: "apps/v1", kind: "Deployment", name: "cell-router" },
    minReplicas: 1,
    maxReplicas: 3,
    metrics: [{
      type: "Resource",
      resource: { name: "cpu", target: { type: "Utilization", averageUtilization: 70 } },
    }],
  },
});

export const cellRouterService = new Service({
  metadata: { name: "cell-router", namespace: "system", labels },
  spec: {
    selector: { "app.kubernetes.io/name": "cell-router" },
    ports: [{ name: "http", port: 8080, targetPort: "http" }],
  },
});

// Cell router ingress routes all cell hostnames through the cell router.
// Nginx wildcard host rules only match a single subdomain level, so we need:
//   *.gitlab.intentius.io  → catches top-level cell aliases (e.g. alpha.gitlab.intentius.io)
//   *.alpha.gitlab.intentius.io → catches two-level cell hosts (e.g. gitlab.alpha.gitlab.intentius.io)
//   *.beta.gitlab.intentius.io  → same for beta, etc.
const cellRouterBackend = {
  paths: [{
    path: "/",
    pathType: "Prefix" as const,
    backend: { service: { name: "cell-router", port: { number: 8080 } } },
  }],
};

export const cellRouterIngress = new Ingress({
  metadata: {
    name: "cell-router",
    namespace: "system",
    annotations: {
      "kubernetes.io/ingress.class": "nginx",
      "nginx.ingress.kubernetes.io/proxy-read-timeout": "3600",
      "nginx.ingress.kubernetes.io/proxy-send-timeout": "3600",
    },
  },
  spec: {
    ingressClassName: "nginx",
    rules: [
      // Top-level wildcard: *.gitlab.intentius.io
      { host: `*.${shared.domain}`, http: cellRouterBackend },
      // Per-cell wildcard: *.alpha.gitlab.intentius.io, *.beta.gitlab.intentius.io, etc.
      // Required because nginx wildcard rules only match a single subdomain level.
      ...cells.map(cell => ({
        host: `*.${cell.name}.${shared.domain}`,
        http: cellRouterBackend,
      })),
    ],
  },
});

// Allow ingress from NGINX ingress controller to cell-router pods
export const cellRouterAllowNginxIngress = new NetworkPolicy({
  metadata: { name: "cell-router-allow-nginx", namespace: "system" },
  spec: {
    podSelector: { matchLabels: { "app.kubernetes.io/name": "cell-router" } },
    ingress: [{
      from: [{ podSelector: { matchLabels: { "app.kubernetes.io/name": "ingress-nginx-controller" } } }],
      ports: [{ protocol: "TCP", port: 8080 }],
    }],
    policyTypes: ["Ingress"],
  },
});

const cellEgressRules = cells.map(cell => ({
  to: [{ namespaceSelector: { matchLabels: { "gitlab.example.com/cell": cell.name } } }],
  // Port 8181 is the workhorse TCP listener (required for git HTTP JWT handling).
  // Port 8080 is the internal rails/puma port (used by /-/health, API, etc.).
  ports: [{ protocol: "TCP", port: 8181 }, { protocol: "TCP", port: 8080 }],
}));

// Allow egress from cell-router to topology service + all cell namespaces
export const cellRouterAllowEgress = new NetworkPolicy({
  metadata: { name: "cell-router-allow-egress", namespace: "system" },
  spec: {
    podSelector: { matchLabels: { "app.kubernetes.io/name": "cell-router" } },
    egress: [
      { ports: [{ protocol: "UDP", port: 53 }, { protocol: "TCP", port: 53 }] },
      {
        to: [{ podSelector: { matchLabels: { "app.kubernetes.io/name": "topology-service" } } }],
        ports: [{ protocol: "TCP", port: 8080 }],
      },
      ...cellEgressRules,
    ],
    policyTypes: ["Egress"],
  },
});

export { routingRulesConfigMap };
