import { Deployment, Service, ConfigMap, PersistentVolumeClaim, ServiceAccount, ClusterRole, ClusterRoleBinding } from "@intentius/chant-lexicon-k8s";
import { createResource } from "@intentius/chant/runtime";
import { cells, shared } from "../config";

const PrometheusRule = createResource("K8s::Monitoring::PrometheusRule", "k8s", {});

const remoteWriteConfig = shared.prometheusRemoteWriteUrl
  ? `remote_write:\n  - url: "${shared.prometheusRemoteWriteUrl}"\n`
  : "";

export const prometheusConfig = new ConfigMap({
  metadata: { name: "prometheus-config", namespace: "system", labels: { "app.kubernetes.io/part-of": "system" } },
  data: {
    "prometheus.yml": `
global:
  scrape_interval: 15s
${remoteWriteConfig}
alerting:
  alertmanagers:
    - static_configs:
        - targets: ['alertmanager.system.svc.cluster.local:9093']

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

// RBAC for Prometheus — needs cluster-wide pod/endpoint/service read to scrape
export const prometheusServiceAccount = new ServiceAccount({
  metadata: { name: "prometheus", namespace: "system", labels: { "app.kubernetes.io/part-of": "system" } },
});

export const prometheusClusterRole = new ClusterRole({
  metadata: { name: "prometheus", labels: { "app.kubernetes.io/part-of": "system" } },
  rules: [
    { apiGroups: [""], resources: ["nodes", "nodes/proxy", "services", "endpoints", "pods"], verbs: ["get", "list", "watch"] },
    { apiGroups: ["extensions", "networking.k8s.io"], resources: ["ingresses"], verbs: ["get", "list", "watch"] },
    { nonResourceURLs: ["/metrics"], verbs: ["get"] },
  ],
});

export const prometheusClusterRoleBinding = new ClusterRoleBinding({
  metadata: { name: "prometheus", labels: { "app.kubernetes.io/part-of": "system" } },
  roleRef: { apiGroup: "rbac.authorization.k8s.io", kind: "ClusterRole", name: "prometheus" },
  subjects: [{ kind: "ServiceAccount", name: "prometheus", namespace: "system" }],
});

// PVC for Prometheus TSDB — 50Gi SSD so 15-day retention survives pod eviction.
// Without this, metrics are in the container's ephemeral filesystem and are lost
// every time the pod is rescheduled (node upgrade, eviction, OOM kill, etc.).
export const prometheusPvc = new PersistentVolumeClaim({
  metadata: {
    name: "prometheus-data",
    namespace: "system",
    labels: { "app.kubernetes.io/name": "prometheus", "app.kubernetes.io/part-of": "system" },
  },
  spec: {
    accessModes: ["ReadWriteOnce"],
    storageClassName: "standard-rwo",  // GKE balanced persistent disk (SSD-backed)
    resources: { requests: { storage: "50Gi" } },
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
    // Recreate is required with ReadWriteOnce PVC — RollingUpdate would start a new pod
    // before the old one releases the PVC lock, causing "lock DB directory" panic.
    strategy: { type: "Recreate" },
    selector: { matchLabels: { "app.kubernetes.io/name": "prometheus" } },
    template: {
      metadata: { labels: { "app.kubernetes.io/name": "prometheus" } },
      spec: {
        serviceAccountName: "prometheus",
        securityContext: {
          fsGroup: 65534,       // prom/prometheus runs as nobody (65534); fsGroup lets it write the PVC
          runAsUser: 65534,
          runAsNonRoot: true,
        },
        containers: [{
          name: "prometheus",
          image: "prom/prometheus:v2.51.0",
          args: [
            "--config.file=/etc/prometheus/prometheus.yml",
            "--storage.tsdb.path=/prometheus",
            "--storage.tsdb.retention.time=15d",
          ],
          ports: [{ name: "http", containerPort: 9090 }],
          resources: { requests: { cpu: "1", memory: "2Gi" }, limits: { cpu: "2", memory: "4Gi" } },
          volumeMounts: [
            { name: "config", mountPath: "/etc/prometheus" },
            { name: "data", mountPath: "/prometheus" },
          ],
        }],
        volumes: [
          { name: "config", configMap: { name: "prometheus-config" } },
          { name: "data", persistentVolumeClaim: { claimName: "prometheus-data" } },
        ],
      },
    },
  },
});

export const prometheusService = new Service({
  metadata: { name: "prometheus", namespace: "system", labels: { "app.kubernetes.io/part-of": "system" } },
  spec: {
    selector: { "app.kubernetes.io/name": "prometheus" },
    ports: [{ name: "http", port: 9090, targetPort: "http" }],
  },
});

// ── AlertManager ──────────────────────────────────────────────────────────────
// Minimal deployment: null receiver captures all alerts and makes them queryable.
// To route alerts to Slack/PagerDuty/email, add receivers and routes to the config.
// See: https://prometheus.io/docs/alerting/latest/configuration/
export const alertmanagerConfig = new ConfigMap({
  metadata: {
    name: "alertmanager-config",
    namespace: "system",
    labels: { "app.kubernetes.io/name": "alertmanager", "app.kubernetes.io/part-of": "system" },
  },
  data: {
    "alertmanager.yml": `
global:
  resolve_timeout: 5m

route:
  receiver: 'null'
  # Add cell-specific routes here, e.g.:
  # routes:
  #   - match:
  #       severity: critical
  #     receiver: pagerduty

receivers:
  - name: 'null'
  # Example Slack receiver:
  # - name: slack
  #   slack_configs:
  #     - api_url: 'https://hooks.slack.com/services/...'
  #       channel: '#gitlab-cells-alerts'
  #       title: 'Cell alert: {{ .CommonLabels.alertname }}'
  #       text: '{{ range .Alerts }}{{ .Annotations.description }}{{ end }}'
`,
  },
});

export const alertmanagerDeployment = new Deployment({
  metadata: {
    name: "alertmanager",
    namespace: "system",
    labels: { "app.kubernetes.io/name": "alertmanager", "app.kubernetes.io/part-of": "system" },
  },
  spec: {
    replicas: 1,
    selector: { matchLabels: { "app.kubernetes.io/name": "alertmanager" } },
    template: {
      metadata: { labels: { "app.kubernetes.io/name": "alertmanager" } },
      spec: {
        containers: [{
          name: "alertmanager",
          image: "prom/alertmanager:v0.27.0",
          args: ["--config.file=/etc/alertmanager/alertmanager.yml", "--storage.path=/alertmanager"],
          ports: [{ name: "http", containerPort: 9093 }],
          resources: { requests: { cpu: "50m", memory: "64Mi" }, limits: { cpu: "200m", memory: "256Mi" } },
          volumeMounts: [{ name: "config", mountPath: "/etc/alertmanager" }],
        }],
        volumes: [{ name: "config", configMap: { name: "alertmanager-config" } }],
      },
    },
  },
});

export const alertmanagerService = new Service({
  metadata: {
    name: "alertmanager",
    namespace: "system",
    labels: { "app.kubernetes.io/part-of": "system" },
  },
  spec: {
    selector: { "app.kubernetes.io/name": "alertmanager" },
    ports: [{ name: "http", port: 9093, targetPort: "http" }],
  },
});

// ── Grafana ───────────────────────────────────────────────────────────────────

// Datasource provisioning — Grafana reads this at startup and auto-configures
// the Prometheus connection. Without this, Grafana starts blank with no data.
export const grafanaDatasourceConfig = new ConfigMap({
  metadata: {
    name: "grafana-datasources",
    namespace: "system",
    labels: { "app.kubernetes.io/name": "grafana", "app.kubernetes.io/part-of": "system" },
  },
  data: {
    "datasources.yaml": `
apiVersion: 1
datasources:
  - name: Prometheus
    type: prometheus
    url: http://prometheus.system.svc.cluster.local:9090
    isDefault: true
    editable: false
`,
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
          volumeMounts: [
            { name: "datasources", mountPath: "/etc/grafana/provisioning/datasources" },
          ],
        }],
        volumes: [
          { name: "datasources", configMap: { name: "grafana-datasources" } },
        ],
      },
    },
  },
});

export const grafanaService = new Service({
  metadata: { name: "grafana", namespace: "system", labels: { "app.kubernetes.io/part-of": "system" } },
  spec: {
    selector: { "app.kubernetes.io/name": "grafana" },
    ports: [{ name: "http", port: 3000, targetPort: "http" }],
  },
});

// Per-cell PrometheusRule CRDs — one RuleGroup per cell driven by cells[] fan-out.
// Recording rules pre-aggregate cell health signals; alerts fire to AlertManager
// which routes them via alertmanager-config (configure receivers there).
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
