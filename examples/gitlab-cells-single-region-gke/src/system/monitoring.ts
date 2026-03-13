import { Deployment, Service, ConfigMap } from "@intentius/chant-lexicon-k8s";
import { createResource } from "@intentius/chant/runtime";
import { cells, shared } from "../config";

const PrometheusRule = createResource("K8s::Monitoring::PrometheusRule", "k8s", {});

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

// Per-cell PrometheusRule CRDs — one RuleGroup per cell driven by cells[] fan-out.
// Recording rules pre-aggregate cell health signals; alerts fire to the routing
// layer via the Topology Service Prometheus query interface (GetCellStatus, roadmap).
export const cellHealthRules = cells.map(cell => new PrometheusRule({
  metadata: {
    name: `cell-${cell.name}-health`,
    namespace: "system",
    labels: {
      "app.kubernetes.io/name": `cell-${cell.name}-health`,
      "app.kubernetes.io/part-of": "system",
      prometheus: "system",
      role: "alert-rules",
    },
  },
  spec: {
    groups: [{
      name: `cell-${cell.name}.health`,
      interval: "30s",
      rules: [
        // DB query latency via pg_stat_activity max transaction duration
        {
          record: "gitlab_cell_db_latency_seconds",
          expr: `histogram_quantile(0.99, rate(pg_stat_activity_max_tx_duration_bucket{namespace="cell-${cell.name}"}[5m]))`,
          labels: { cell: cell.name },
        },
        // Webservice readiness ratio: ready pods / desired pods
        {
          record: "gitlab_cell_webservice_ready_ratio",
          expr: `kube_deployment_status_replicas_ready{namespace="cell-${cell.name}", deployment=~".*webservice.*"} / kube_deployment_spec_replicas{namespace="cell-${cell.name}", deployment=~".*webservice.*"}`,
          labels: { cell: cell.name },
        },
        // CI runner queue depth: pending jobs in this cell's namespace
        {
          record: "gitlab_cell_runner_queue_depth",
          expr: `sum(gitlab_runner_jobs{namespace="cell-${cell.name}", state="waiting"}) or vector(0)`,
          labels: { cell: cell.name },
        },
        // Composite health score 0-1: combines webservice readiness + DB latency.
        // score < shared.routerHealthThreshold triggers CellUnhealthy alert and
        // cell-router failover to next available cell.
        {
          record: "gitlab_cell_health_score",
          expr: `
            clamp_max(
              gitlab_cell_webservice_ready_ratio{cell="${cell.name}"} *
              clamp_max(1 - (gitlab_cell_db_latency_seconds{cell="${cell.name}"} / 5), 1),
            1)
          `.trim(),
          labels: { cell: cell.name },
        },
      ],
    }, {
      name: `cell-${cell.name}.alerts`,
      rules: [
        {
          alert: "CellUnhealthy",
          expr: `gitlab_cell_health_score{cell="${cell.name}"} < ${shared.routerHealthThreshold}`,
          for: "2m",
          labels: { severity: "critical", cell: cell.name },
          annotations: {
            summary: `Cell ${cell.name} is unhealthy`,
            description: `Health score for cell ${cell.name} has been below ${shared.routerHealthThreshold} for 2 minutes. Cell router will failover to next available cell.`,
          },
        },
        {
          alert: "CellDegraded",
          expr: `gitlab_cell_health_score{cell="${cell.name}"} < 0.8`,
          for: "5m",
          labels: { severity: "warning", cell: cell.name },
          annotations: {
            summary: `Cell ${cell.name} is degraded`,
            description: `Health score for cell ${cell.name} has been below 0.8 for 5 minutes.`,
          },
        },
        {
          alert: "CellRunnerQueueBacklog",
          expr: `gitlab_cell_runner_queue_depth{cell="${cell.name}"} > 100`,
          for: "5m",
          labels: { severity: "warning", cell: cell.name },
          annotations: {
            summary: `Cell ${cell.name} runner queue backlog`,
            description: `More than 100 CI jobs have been pending in cell ${cell.name} for 5 minutes.`,
          },
        },
      ],
    }],
  },
}));
