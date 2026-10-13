/**
 * `chant init --lexicon grafana` scaffolds.
 *
 * - default: a Prometheus datasource and a job overview dashboard with a
 *   typed variable, in a folder.
 * - `red`: rate, errors and duration per service from the OpenTelemetry
 *   collector's span metrics, over a Prometheus Grafana already has
 *   (`ExternalDatasource`), in a pinned `Folder`.
 * - `k8s-pods`: CPU, memory, restarts and pod phase per namespace, delivered
 *   as ConfigMaps the Grafana Helm chart's sidecar loads, from the `/k8s`
 *   subpath. Builds with the k8s lexicon.
 * - `slo`: an SLO's recording rules, its dashboard and its burn-rate alerts
 *   as Grafana-managed rules. Builds with the prometheus lexicon.
 *
 * The otel, prometheus and k8s lexicons these import are dependencies of
 * the grafana lexicon, so they are installed with it. The templates that
 * build with a second lexicon ship their own `chant.config.ts` and a build
 * script without `--lexicon`, so every lexicon's output and checks run.
 */
import type { InitTemplateSet } from "@intentius/chant/lexicon";

// ── default ────────────────────────────────────────────────────────────

const DEFAULT_DATASOURCES = `/**
 * The datasource the dashboards query, declared in the same build root so
 * GRAF101 and GRAF102 check every panel's reference against it.
 */
import { Datasource } from "@intentius/chant-lexicon-grafana";

const prometheus = new Datasource({ name: "Prometheus", type: "prometheus", url: "http://prometheus:9090", isDefault: true });

export { prometheus };
`;

const DEFAULT_DASHBOARD = `/**
 * One dashboard: which of a job's targets are up, and how long their
 * scrapes take. Panels without a gridPos are laid out left to right.
 */
import { Dashboard, PromQuery, QueryVariable, StatPanel, TimeSeriesPanel } from "@intentius/chant-lexicon-grafana";
import { prometheus } from "./datasources";

const jobQuery = { query: "label_values(up, job)", qryType: 1 as const, label: "job", metric: "up" };
const job = new QueryVariable({ name: "job", label: "Job", datasource: prometheus, query: jobQuery, refresh: "onTimeRangeChange", sort: 1 });

const up = new PromQuery({ expr: 'sum(up{job="$job"})', instant: true });
const targetsUp = new StatPanel({ title: "Targets up", datasource: prometheus, targets: [up] });

const scrape = new PromQuery({ expr: 'avg by (instance) (scrape_duration_seconds{job="$job"})', legendFormat: "{{instance}}" });
const seconds = { defaults: { unit: "s" } };
const scrapeDuration = new TimeSeriesPanel({ title: "Scrape duration", datasource: prometheus, targets: [scrape], fieldConfig: seconds });

const lastHour = { from: "now-1h", to: "now" };

const overview = new Dashboard({
  title: "Overview",
  uid: "overview",
  tags: ["chant"],
  time: lastHour,
  refresh: "30s",
  variables: [job],
  panels: [targetsUp, scrapeDuration],
  folder: "Services",
});

export { overview };
`;

// ── red ────────────────────────────────────────────────────────────────

const RED_DATASOURCES = `/**
 * The Prometheus the dashboard reads, one Grafana already has. It is checked
 * against (GRAF101, GRAF102) and never provisioned: set \`uid\` to its uid,
 * from Connections > Data sources in Grafana.
 */
import { ExternalDatasource } from "@intentius/chant-lexicon-grafana";

const prometheus = new ExternalDatasource({ type: "prometheus", uid: "prometheus", name: "Prometheus" });

export { prometheus };
`;

const RED_DASHBOARD = `/**
 * Rate, errors and duration per service, from the span metrics the
 * OpenTelemetry collector's \`spanmetrics\` connector writes. The metric and
 * label names come from the connector's settings, so change them here to
 * match your collector (or pass the connector itself, if the collector is
 * declared with the otel lexicon) and every query follows.
 */
import { Folder, RedDashboard, type SpanKind } from "@intentius/chant-lexicon-grafana";
import { spanMetricsNames } from "@intentius/chant-lexicon-otel";
import { prometheus } from "./datasources";

const milliseconds = { unit: "ms" };
const connector = { namespace: "traces.span.metrics", histogram: milliseconds };
const names = spanMetricsNames(connector);

// The spans that serve a request or consume a message, so a service's own
// outgoing calls don't count toward its rate. [] counts every kind.
const served: SpanKind[] = ["SPAN_KIND_SERVER", "SPAN_KIND_CONSUMER"];

// A Folder pins the uid, for links and alert rules that name it.
const observability = new Folder({ title: "Observability", uid: "observability" });

const services = RedDashboard({ spanMetrics: names, datasource: prometheus, spanKinds: served, folder: observability, uid: "services-red" });

export { observability, services };
`;

// ── k8s-pods ───────────────────────────────────────────────────────────

const K8S_CONFIG = `import type { ChantConfig } from "@intentius/chant";

// The dashboard and the ConfigMaps that deliver it share one build root: the
// grafana output is checked by the GRAF checks, the ConfigMaps are applied
// with kubectl.
export default { lexicons: ["k8s", "grafana"] } satisfies ChantConfig;
`;

const K8S_DATASOURCES = `/**
 * The Prometheus that scrapes cAdvisor and kube-state-metrics, as Grafana
 * reaches it inside the cluster.
 */
import { Datasource } from "@intentius/chant-lexicon-grafana";

const prometheus = new Datasource({
  name: "Prometheus",
  type: "prometheus",
  uid: "prometheus",
  url: "http://prometheus-server.monitoring.svc:80",
  isDefault: true,
});

export { prometheus };
`;

const K8S_VARIABLES = `/**
 * Which namespace, and which of its pods. Queries use them as $namespace
 * and $pod; \`pod\` takes several values, or all of them.
 */
import { QueryVariable } from "@intentius/chant-lexicon-grafana";
import { prometheus } from "./datasources";

const namespace = new QueryVariable({
  name: "namespace",
  label: "Namespace",
  datasource: prometheus,
  query: "label_values(kube_pod_info, namespace)",
  refresh: "onTimeRangeChange",
  sort: 1,
});

const pod = new QueryVariable({
  name: "pod",
  label: "Pod",
  datasource: prometheus,
  query: 'label_values(kube_pod_info{namespace="$namespace"}, pod)',
  refresh: "onTimeRangeChange",
  sort: 1,
  multi: true,
  includeAll: true,
});

export { namespace, pod };
`;

const K8S_QUERIES = `/**
 * PromQL over cAdvisor (container_*) and kube-state-metrics (kube_*).
 */
import { PromQuery } from "@intentius/chant-lexicon-grafana";

const scope = 'namespace="$namespace", pod=~"$pod"';

const cpu = new PromQuery({
  expr: \`sum by (pod) (rate(container_cpu_usage_seconds_total{\${scope}, container!=""}[$__rate_interval]))\`,
  legendFormat: "{{pod}}",
});

const memory = new PromQuery({
  expr: \`sum by (pod) (container_memory_working_set_bytes{\${scope}, container!=""})\`,
  legendFormat: "{{pod}}",
});

const restarts = new PromQuery({
  expr: \`sum by (pod) (increase(kube_pod_container_status_restarts_total{\${scope}}[1h]))\`,
  legendFormat: "{{pod}}",
});

const phase = new PromQuery({
  expr: \`sum by (pod, phase) (kube_pod_status_phase{\${scope}}) > 0\`,
  instant: true,
  format: "table",
});

export { cpu, memory, restarts, phase };
`;

const K8S_DASHBOARD = `/**
 * Pods in a namespace: what they use, how often they restart, and which
 * phase each is in.
 */
import { Dashboard, TablePanel, TimeSeriesPanel, transformation } from "@intentius/chant-lexicon-grafana";
import { prometheus } from "./datasources";
import { namespace, pod } from "./variables";
import { cpu, memory, restarts, phase } from "./queries";

const cores = { defaults: { unit: "suffix: cores" } };
const cpuPanel = new TimeSeriesPanel({ title: "CPU", datasource: prometheus, targets: [cpu], fieldConfig: cores });

const bytes = { defaults: { unit: "bytes" } };
const memoryPanel = new TimeSeriesPanel({ title: "Memory working set", datasource: prometheus, targets: [memory], fieldConfig: bytes });

const count = { defaults: { unit: "short", decimals: 0 } };
const restartPanel = new TimeSeriesPanel({ title: "Restarts in the last hour", datasource: prometheus, targets: [restarts], fieldConfig: count });

// The query returns one row per pod with its phase; drop the time and value columns.
const hidden = { Time: true, Value: true };
const renamed = { pod: "Pod", phase: "Phase" };
const phaseColumns = [transformation("organize", { excludeByName: hidden, renameByName: renamed })];
const phasePanel = new TablePanel({ title: "Pod phase", datasource: prometheus, targets: [phase], transformations: phaseColumns });

const pods = new Dashboard({
  title: "Kubernetes pods",
  uid: "k8s-pods",
  tags: ["chant", "kubernetes"],
  refresh: "30s",
  variables: [namespace, pod],
  panels: [cpuPanel, memoryPanel, restartPanel, phasePanel],
  folder: "Kubernetes",
});

export { pods };
`;

const K8S_DELIVERY = `/**
 * The dashboard and the datasource as ConfigMaps, labelled the way the
 * Grafana Helm chart's sidecar (also in kube-prometheus-stack) finds them:
 * \`grafana_dashboard: "1"\` and \`grafana_datasource: "1"\`, the folder in the
 * \`k8s-sidecar-target-directory\` annotation. \`kubectl apply -f\` the k8s
 * output into the namespace Grafana watches.
 */
import { GrafanaConfigMaps } from "@intentius/chant-lexicon-grafana/k8s";
import { prometheus } from "./datasources";
import { pods } from "./dashboard";

/** The namespace Grafana's sidecar watches for ConfigMaps. */
export const GRAFANA_NAMESPACE = "monitoring";

const delivered = [prometheus, pods];
const labels = { "app.kubernetes.io/part-of": "grafana" };

const grafanaConfigMaps = GrafanaConfigMaps({ entities: delivered, namespace: GRAFANA_NAMESPACE, labels });

export { grafanaConfigMaps };
`;

// ── slo ────────────────────────────────────────────────────────────────

const SLO_CONFIG = `import type { ChantConfig } from "@intentius/chant";

// The SLO's Prometheus rules, and the Grafana dashboard and alert rules that
// read what they record, share one build root: GRAF108 and GRAF112 check the
// queries against the datasource declared here.
export default { lexicons: ["prometheus", "grafana"] } satisfies ChantConfig;
`;

const SLO_DATASOURCES = `/**
 * The Prometheus that evaluates the SLO's recording rules.
 */
import { Datasource } from "@intentius/chant-lexicon-grafana";

const prometheus = new Datasource({ name: "Prometheus", type: "prometheus", uid: "prometheus", url: "http://prometheus:9090", isDefault: true });

export { prometheus };
`;

const SLO_DECLARATION = `/**
 * The SLO: 99.9% of checkout requests answer without a 5xx over 30 days.
 * The prometheus lexicon builds its recording rules; the dashboard and the
 * alert rules read the series they record, by the same names.
 */
import { Slo } from "@intentius/chant-lexicon-prometheus";

const sli = {
  errors: 'sum(rate(http_requests_total{job="checkout",code=~"5.."}[{{window}}]))',
  total: 'sum(rate(http_requests_total{job="checkout"}[{{window}}]))',
};
const team = { team: "payments" };

const checkout = Slo({
  name: "checkout",
  objective: 0.999,
  window: "30d",
  description: "Checkout requests answer without a 5xx.",
  sli,
  labels: team,
});

export { checkout };
`;

const SLO_DASHBOARD = `/**
 * The SLO's dashboard (SLI against the objective, error budget left, each
 * burn-rate pair against the rate it fires at), and the same burn rates as
 * Grafana-managed alert rules in the same folder.
 */
import { SloAlertRules, SloDashboard } from "@intentius/chant-lexicon-grafana";
import { prometheus } from "./datasources";
import { checkout } from "./slo";

const checkoutSlo = SloDashboard({ slo: checkout, datasource: prometheus, folder: "SLOs" });

const team = { team: "payments" };
const runbook = { runbook_url: "https://runbooks.example.com/checkout-slo" };
const checkoutBurn = SloAlertRules({ slo: checkout, datasource: prometheus, folder: "SLOs", labels: team, annotations: runbook });

export { checkoutSlo, checkoutBurn };
`;

// Build every lexicon the config names, not just grafana.
const ALL_LEXICONS = { build: "chant build src", dev: "chant build src --watch" };

export const DEFAULT_TEMPLATE: InitTemplateSet = {
  src: { "datasources.ts": DEFAULT_DATASOURCES, "dashboard.ts": DEFAULT_DASHBOARD },
};

export const RED_TEMPLATE: InitTemplateSet = {
  src: { "datasources.ts": RED_DATASOURCES, "red.ts": RED_DASHBOARD },
};

export const K8S_PODS_TEMPLATE: InitTemplateSet = {
  src: {
    "datasources.ts": K8S_DATASOURCES,
    "variables.ts": K8S_VARIABLES,
    "queries.ts": K8S_QUERIES,
    "dashboard.ts": K8S_DASHBOARD,
    "k8s.ts": K8S_DELIVERY,
  },
  root: { "chant.config.ts": K8S_CONFIG },
  scripts: ALL_LEXICONS,
};

export const SLO_TEMPLATE: InitTemplateSet = {
  src: { "datasources.ts": SLO_DATASOURCES, "slo.ts": SLO_DECLARATION, "dashboards.ts": SLO_DASHBOARD },
  root: { "chant.config.ts": SLO_CONFIG },
  scripts: ALL_LEXICONS,
};

/** The template names `chant init --lexicon grafana --template <name>` takes, besides the default. */
export const TEMPLATE_NAMES = ["red", "k8s-pods", "slo"] as const;
