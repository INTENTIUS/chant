// Prometheus monitoring for CockroachDB metrics (west region).

import { Deployment, Service, ConfigMap } from "@intentius/chant-lexicon-k8s";

const NAMESPACE = "crdb-west";

export const prometheusConfig = new ConfigMap({
  metadata: { name: "prometheus-config", namespace: NAMESPACE },
  data: {
    "prometheus.yml": `
global:
  scrape_interval: 15s
scrape_configs:
  - job_name: "cockroachdb"
    kubernetes_sd_configs:
      - role: pod
        namespaces:
          names: ["${NAMESPACE}"]
    relabel_configs:
      - source_labels: [__meta_kubernetes_pod_label_app_kubernetes_io_name]
        regex: "cockroachdb"
        action: keep
      - source_labels: [__meta_kubernetes_pod_ip]
        target_label: __address__
        replacement: "\${1}:8080"
      - source_labels: [__meta_kubernetes_pod_name]
        target_label: instance
    metrics_path: "/_status/vars"
`,
  },
});

export const prometheusDeployment = new Deployment({
  metadata: {
    name: "prometheus",
    namespace: NAMESPACE,
    labels: { "app.kubernetes.io/name": "prometheus", "app.kubernetes.io/managed-by": "chant" },
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
          resources: { requests: { cpu: "500m", memory: "1Gi" }, limits: { cpu: "1", memory: "2Gi" } },
          volumeMounts: [{ name: "config", mountPath: "/etc/prometheus" }],
        }],
        volumes: [{ name: "config", configMap: { name: "prometheus-config" } }],
      },
    },
  },
});

export const prometheusService = new Service({
  metadata: { name: "prometheus", namespace: NAMESPACE },
  spec: {
    selector: { "app.kubernetes.io/name": "prometheus" },
    ports: [{ name: "http", port: 9090, targetPort: "http" }],
  },
});
