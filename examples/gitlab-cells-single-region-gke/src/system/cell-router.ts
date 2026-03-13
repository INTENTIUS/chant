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
          // Replace with a real routing proxy image (e.g. Envoy + Lua, or a
          // purpose-built Go binary) in production. The nginx image here
          // serves as a typed placeholder that passes build + lint.
          image: "nginx:1.25-alpine",
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

// Single wildcard Ingress entry routes all cell hostnames through the cell router
// rather than directly to individual cell services. The router proxies to the
// correct cell based on session token, routable token, or org-slug path lookup.
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
    rules: [{
      host: `*.${shared.domain}`,
      http: {
        paths: [{
          path: "/",
          pathType: "Prefix",
          backend: { service: { name: "cell-router", port: { number: 8080 } } },
        }],
      },
    }],
  },
});

// Allow ingress from NGINX ingress controller to cell-router pods
export const cellRouterAllowNginxIngress = new NetworkPolicy({
  metadata: { name: "cell-router-allow-nginx", namespace: "system" },
  spec: {
    podSelector: { matchLabels: { "app.kubernetes.io/name": "cell-router" } },
    ingress: [{
      from: [{ podSelector: { matchLabels: { "app.kubernetes.io/name": "ingress-nginx" } } }],
      ports: [{ protocol: "TCP", port: 8080 }],
    }],
    policyTypes: ["Ingress"],
  },
});

const cellEgressRules = cells.map(cell => ({
  to: [{ namespaceSelector: { matchLabels: { "gitlab.example.com/cell": cell.name } } }],
  ports: [{ protocol: "TCP", port: 8080 }],
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
