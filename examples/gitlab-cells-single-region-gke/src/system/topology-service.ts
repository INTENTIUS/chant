import { Deployment, Service, ConfigMap } from "@intentius/chant-lexicon-k8s";
import { createResource } from "@intentius/chant/runtime";
import { shared } from "../config";

const ExternalSecret = createResource("K8s::ExternalSecrets::ExternalSecret", "k8s", {});

const ServiceMonitor = createResource("K8s::Monitoring::ServiceMonitor", "k8s", {});

const labels = {
  "app.kubernetes.io/name": "topology-service",
  "app.kubernetes.io/part-of": "system",
};

export const topologyConfig = new ConfigMap({
  metadata: { name: "topology-service", namespace: "system", labels },
  data: {
    "config.yaml": `
database:
  host: ${process.env.TOPOLOGY_DB_HOST ?? "topology-db-ip"}
  port: 5432
  name: topology_production
  user: gitlab-topology-db-admin
  sslmode: require
server:
  port: 8080
# Prometheus address used by the topology service to query cell health scores
# before responding to routing queries. When GetCellStatus (roadmap) is called,
# the service includes health_score in its response so the cell router can
# make health-aware routing decisions without a separate Prometheus query.
prometheus:
  address: "prometheus.system.svc.cluster.local:9090"
  health_query: "gitlab_cell_health_score"
`,
  },
});

export const topologyDeployment = new Deployment({
  metadata: { name: "topology-service", namespace: "system", labels },
  spec: {
    // 2 replicas: topology service is in the critical path for path-based routing;
    // a single replica is a SPOF. HPA not added here since topology lookups are
    // DB-bound, not CPU-bound — scale by adding read replicas to the DB instead.
    replicas: 2,
    selector: { matchLabels: { "app.kubernetes.io/name": "topology-service" } },
    template: {
      metadata: { labels: { "app.kubernetes.io/name": "topology-service" } },
      spec: {
        containers: [{
          name: "topology-service",
          image: shared.topologyServiceImage,
          // IfNotPresent prevents repeated pulls of `:latest` tag on pod restarts,
          // which would bypass the image digest pinning in the CI push step.
          imagePullPolicy: "IfNotPresent",
          ports: [{ name: "http", containerPort: 8080 }],
          resources: {
            requests: { cpu: "250m", memory: "256Mi" },
            limits: { cpu: "1", memory: "512Mi" },
          },
          env: [{
            name: "DB_PASSWORD",
            valueFrom: { secretKeyRef: { name: "topology-db-password", key: "password" } },
          }],
          livenessProbe: { httpGet: { path: "/healthz", port: 8080 }, initialDelaySeconds: 10, periodSeconds: 10 },
          readinessProbe: { httpGet: { path: "/healthz", port: 8080 }, initialDelaySeconds: 5, periodSeconds: 5 },
          volumeMounts: [{ name: "config", mountPath: "/etc/topology-service" }],
        }],
        volumes: [{ name: "config", configMap: { name: "topology-service" } }],
      },
    },
  },
});

export const topologyService = new Service({
  metadata: { name: "topology-service", namespace: "system", labels },
  spec: {
    selector: { "app.kubernetes.io/name": "topology-service" },
    ports: [{ name: "http", port: 8080, targetPort: "http" }],
  },
});

// ExternalSecret: syncs gitlab-topology-db-password from GCP Secret Manager
// into the system namespace so the topology-service Deployment can mount it.
export const topologyDbPasswordSecret = new ExternalSecret({
  metadata: { name: "topology-db-password", namespace: "system", labels: { "app.kubernetes.io/part-of": "system" } },
  spec: {
    refreshInterval: "1h",
    secretStoreRef: { name: "gcp-secret-manager", kind: "ClusterSecretStore" },
    target: { name: "topology-db-password" },
    data: [{ secretKey: "password", remoteRef: { key: "gitlab-topology-db-password" } }],
  },
});

// ServiceMonitor scraped by the prometheus-operator Prometheus instance.
// Exposes topology-service internal metrics (routing decisions, DB query
// latency, cache hit rate) at /metrics on port 8080, interval 15s.
export const topologyServiceMonitor = new ServiceMonitor({
  metadata: {
    name: "topology-service",
    namespace: "system",
    labels: { ...labels, prometheus: "system" },
  },
  spec: {
    selector: { matchLabels: { "app.kubernetes.io/name": "topology-service" } },
    namespaceSelector: { matchNames: ["system"] },
    endpoints: [{
      port: "http",
      path: "/metrics",
      interval: "15s",
    }],
  },
});
