import { Deployment, Service, ConfigMap } from "@intentius/chant-lexicon-k8s";
import { cells, shared } from "../config";

const remoteWriteConfig = shared.prometheusRemoteWriteUrl
  ? `remote_write:\n  - url: "${shared.prometheusRemoteWriteUrl}"\n`
  : "";

export const prometheusConfig = new ConfigMap({
  metadata: { name: "prometheus-config", namespace: "system" },
  data: {
    "prometheus.yml": `
global:
  scrape_interval: 15s
${remoteWriteConfig}
scrape_configs:
  - job_name: "gitlab-cells"
    kubernetes_sd_configs:
      - role: pod
        namespaces:
          names: [${cells.map(c => `"cell-${c.name}"`).join(", ")}]
    relabel_configs:
      - source_labels: [__meta_kubernetes_namespace]
        regex: "cell-(.*)"
        target_label: cell
  - job_name: "system"
    kubernetes_sd_configs:
      - role: pod
        namespaces:
          names: ["system"]
`,
  },
});

export const prometheusDeployment = new Deployment({
  metadata: {
    name: "prometheus",
    namespace: "system",
    labels: { "app.kubernetes.io/name": "prometheus", "app.kubernetes.io/part-of": "system" },
  },
  spec: {
    replicas: 1,
    selector: { matchLabels: { "app.kubernetes.io/name": "prometheus" } },
    template: {
      metadata: { labels: { "app.kubernetes.io/name": "prometheus" } },
      spec: {
        containers: [{
          name: "prometheus",
          image: "prom/prometheus:v2.51.0",
          args: ["--config.file=/etc/prometheus/prometheus.yml", "--storage.tsdb.retention.time=15d"],
          ports: [{ name: "http", containerPort: 9090 }],
          resources: { requests: { cpu: "1", memory: "2Gi" }, limits: { cpu: "2", memory: "4Gi" } },
          volumeMounts: [{ name: "config", mountPath: "/etc/prometheus" }],
        }],
        volumes: [{ name: "config", configMap: { name: "prometheus-config" } }],
      },
    },
  },
});

export const prometheusService = new Service({
  metadata: { name: "prometheus", namespace: "system" },
  spec: {
    selector: { "app.kubernetes.io/name": "prometheus" },
    ports: [{ name: "http", port: 9090, targetPort: "http" }],
  },
});

export const grafanaDeployment = new Deployment({
  metadata: {
    name: "grafana",
    namespace: "system",
    labels: { "app.kubernetes.io/name": "grafana", "app.kubernetes.io/part-of": "system" },
  },
  spec: {
    replicas: 1,
    selector: { matchLabels: { "app.kubernetes.io/name": "grafana" } },
    template: {
      metadata: { labels: { "app.kubernetes.io/name": "grafana" } },
      spec: {
        containers: [{
          name: "grafana",
          image: "grafana/grafana:10.4.1",
          ports: [{ name: "http", containerPort: 3000 }],
          resources: { requests: { cpu: "250m", memory: "256Mi" }, limits: { cpu: "1", memory: "512Mi" } },
          env: [
            { name: "GF_SECURITY_ADMIN_PASSWORD", valueFrom: { secretKeyRef: { name: "grafana-admin", key: "password" } } },
          ],
        }],
      },
    },
  },
});

export const grafanaService = new Service({
  metadata: { name: "grafana", namespace: "system" },
  spec: {
    selector: { "app.kubernetes.io/name": "grafana" },
    ports: [{ name: "http", port: 3000, targetPort: "http" }],
  },
});
