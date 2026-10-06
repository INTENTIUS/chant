/**
 * The metric names a collector emits, as the `prometheus` exporter serves
 * them: `spanMetricsNames()` for a `spanmetrics` connector, and the naming
 * rules `genAiMetrics()` uses too.
 *
 * A dashboard or an SLO reads names from here instead of repeating them, so
 * renaming the connector's namespace (or the exporter's) moves every query
 * built from it.
 *
 * Naming follows the collector's Prometheus translation at `COLLECTOR_PIN`
 * with the exporter's defaults: `.` and any other character Prometheus does
 * not allow become `_`; counters take `_total`; a unit becomes a suffix
 * (`ms` is `_milliseconds`, `s` is `_seconds`); the exporter's `namespace`
 * is a prefix joined with `_`; `add_metric_suffixes: false` drops the
 * suffixes. Attribute names become label names the same way
 * (`service.name` is `service_name`).
 *
 * This module holds types and string functions only, so a lexicon that
 * builds queries from it does not load the collector components.
 */

import { canonicalComponentType } from "./model";

/** A metric a collector component emits, as the collector names it and as Prometheus exposes it. */
export interface CollectorMetric {
  /** The OTLP metric name. */
  name: string;
  /** The name the `prometheus` exporter serves; histograms add `_bucket`, `_sum` and `_count`. */
  prometheus: string;
  type: "sum" | "histogram";
  unit?: string;
  /** Attribute names on its data points, beyond the resource. Prometheus labels replace `.` with `_`. */
  dimensions: string[];
}

/** The four dimensions spanmetrics puts on every metric unless `exclude_dimensions` names them. */
export const SPANMETRICS_DEFAULT_DIMENSIONS: readonly string[] = Object.freeze(["service.name", "span.name", "span.kind", "status.code"]);

/** The spanmetrics namespace when the connector sets none. */
export const SPANMETRICS_DEFAULT_NAMESPACE = "traces.span.metrics";

/** The `status.code` value of a span that ended in error: the value an error-ratio query selects. */
export const SPAN_STATUS_ERROR = "STATUS_CODE_ERROR";

/** The Prometheus unit words for the units collector components use. */
const UNIT_WORDS: Record<string, string> = {
  ms: "milliseconds",
  s: "seconds",
  us: "microseconds",
  ns: "nanoseconds",
  By: "bytes",
  "1": "ratio",
};

/** How the `prometheus` exporter is configured, as far as naming goes. */
export interface PrometheusNaming {
  /** The exporter's `namespace`, put in front of every name and joined with `_`. */
  namespace?: string;
  /** The exporter's `add_metric_suffixes` (default true): unit and `_total` suffixes. */
  add_metric_suffixes?: boolean;
}

/** An attribute name as a Prometheus label: `service.name` is `service_name`. */
export function prometheusLabel(attribute: string): string {
  const label = attribute.replace(/[^A-Za-z0-9_]/g, "_");
  return /^[0-9]/.test(label) ? `key_${label}` : label;
}

/**
 * An OTLP metric name as the `prometheus` exporter serves it.
 *
 * @param type `sum` (a monotonic counter, `_total`) or `histogram`.
 * @param unit The metric's unit, e.g. `ms`. Units in braces (`{call}`) add nothing.
 */
export function prometheusMetricName(name: string, type: "sum" | "histogram", unit?: string, naming: PrometheusNaming = {}): string {
  let out = name.replace(/[^A-Za-z0-9_:]/g, "_");
  if (naming.namespace) out = `${naming.namespace.replace(/[^A-Za-z0-9_:]/g, "_")}_${out}`;
  if (naming.add_metric_suffixes === false) return out;
  const word = unit && !unit.startsWith("{") ? (UNIT_WORDS[unit] ?? unit.replace(/[^A-Za-z0-9_:]/g, "_")) : undefined;
  if (word && !out.endsWith(`_${word}`)) out = `${out}_${word}`;
  if (type === "sum" && !out.endsWith("_total")) out = `${out}_total`;
  return out;
}

/** The parts of a spanmetrics config the metric names depend on. */
export interface SpanMetricsNamingConfig {
  namespace?: string;
  dimensions?: Array<{ name: string }>;
  calls_dimensions?: Array<{ name: string }>;
  exclude_dimensions?: string[];
  histogram?: { disable?: boolean; unit?: "ms" | "s"; dimensions?: Array<{ name: string }> };
  events?: { enabled?: boolean; dimensions?: Array<{ name: string }> };
}

/** The metrics one `spanmetrics` connector emits, and the labels a query selects them by. */
export interface SpanMetricsNames {
  /** The connector's namespace (empty: no prefix). */
  namespace: string;
  /** Span count; `status.code` = `STATUS_CODE_ERROR` selects the errors. */
  calls: CollectorMetric;
  /** Span duration histogram. Absent when `histogram.disable` is set. */
  duration?: CollectorMetric;
  /** Span event count. Present only when `events.enabled` is set. */
  events?: CollectorMetric;
  /**
   * The default dimensions as Prometheus labels. One is absent when
   * `exclude_dimensions` leaves it out, so a query can't select by it.
   */
  labels: { service?: string; spanName?: string; spanKind?: string; statusCode?: string };
  /** The `status_code` value of an error span. */
  errorStatus: string;
}

type Declared = { componentType?: unknown; props?: unknown };

function configOf(connector: SpanMetricsNamingConfig | Declared): SpanMetricsNamingConfig {
  const d = connector as Declared;
  if (typeof d.componentType === "string") {
    if (canonicalComponentType("connector", d.componentType) !== "spanmetrics") throw new Error(`spanMetricsNames: expected a spanmetrics connector, got ${d.componentType}`);
    return (d.props ?? {}) as SpanMetricsNamingConfig;
  }
  return connector as SpanMetricsNamingConfig;
}

/**
 * The Prometheus names of the metrics a `spanmetrics` connector emits, read
 * from its declaration: its namespace, dimensions and histogram unit, and
 * optionally the `prometheus` exporter's namespace and suffix setting.
 *
 * @example
 * ```ts
 * const spans = new SpanMetricsConnector({ namespace: "shop", histogram: { unit: "s" } });
 * spanMetricsNames(spans).calls.prometheus;    // "shop_calls_total"
 * spanMetricsNames(spans).duration!.prometheus; // "shop_duration_seconds"
 * ```
 */
export function spanMetricsNames(
  connector: SpanMetricsNamingConfig | Declared,
  exporter?: PrometheusNaming | { props?: PrometheusNaming },
): SpanMetricsNames {
  const c = configOf(connector);
  const naming: PrometheusNaming =
    exporter && "props" in exporter && typeof exporter.props === "object" ? (exporter.props as PrometheusNaming) : ((exporter ?? {}) as PrometheusNaming);
  const namespace = c.namespace ?? SPANMETRICS_DEFAULT_NAMESPACE;
  const metricName = (n: string) => (namespace === "" ? n : `${namespace}.${n}`);
  const excluded = new Set(c.exclude_dimensions ?? []);
  const defaults = SPANMETRICS_DEFAULT_DIMENSIONS.filter((d) => !excluded.has(d));
  const names = (extra?: Array<{ name: string }>) => (extra ?? []).map((d) => d.name);
  const common = [...defaults, ...names(c.dimensions)];

  const metric = (n: string, type: "sum" | "histogram", dims: string[], unit?: string): CollectorMetric => ({
    name: metricName(n),
    prometheus: prometheusMetricName(metricName(n), type, unit, naming),
    type,
    ...(unit ? { unit } : {}),
    dimensions: dims,
  });

  const label = (attr: string) => (defaults.includes(attr) ? prometheusLabel(attr) : undefined);
  const labels: SpanMetricsNames["labels"] = {};
  const service = label("service.name");
  const spanName = label("span.name");
  const spanKind = label("span.kind");
  const statusCode = label("status.code");
  if (service) labels.service = service;
  if (spanName) labels.spanName = spanName;
  if (spanKind) labels.spanKind = spanKind;
  if (statusCode) labels.statusCode = statusCode;

  return {
    namespace,
    calls: metric("calls", "sum", [...common, ...names(c.calls_dimensions)]),
    ...(c.histogram?.disable ? {} : { duration: metric("duration", "histogram", [...common, ...names(c.histogram?.dimensions)], c.histogram?.unit ?? "ms") }),
    ...(c.events?.enabled ? { events: metric("events", "sum", [...common, ...names(c.events.dimensions)]) } : {}),
    labels,
    errorStatus: SPAN_STATUS_ERROR,
  };
}

/** The prefix of every metric the `servicegraph` connector emits; the connector takes no namespace. */
export const SERVICEGRAPH_NAMESPACE = "traces_service_graph";

/** The parts of a servicegraph config the metric labels depend on. */
export interface ServiceGraphNamingConfig {
  dimensions?: string[];
  virtual_node_extra_label?: boolean;
}

/** The metrics one `servicegraph` connector emits. */
export interface ServiceGraphNames {
  /** Requests per edge. */
  requests: CollectorMetric;
  /** Failed requests per edge. */
  failed: CollectorMetric;
  /** Server-side request duration histogram, in seconds. */
  serverDuration: CollectorMetric;
  /** Client-side request duration histogram, in seconds. */
  clientDuration: CollectorMetric;
}

/**
 * The Prometheus names of the metrics a `servicegraph` connector emits at
 * `COLLECTOR_PIN`, with its default feature gates: latency in seconds, under
 * `_request_server` and `_request_client`. Every metric carries `client`,
 * `server`, `connection_type` and `failed`, `client_<d>` and `server_<d>` for
 * each configured dimension, and `virtual_node` when
 * `virtual_node_extra_label` is set (connector/servicegraphconnector/connector.go).
 */
export function serviceGraphNames(
  connector: ServiceGraphNamingConfig | Declared,
  exporter?: PrometheusNaming | { props?: PrometheusNaming },
): ServiceGraphNames {
  const d = connector as Declared;
  if (typeof d.componentType === "string" && d.componentType !== "servicegraph") {
    throw new Error(`serviceGraphNames: expected a servicegraph connector, got ${d.componentType}`);
  }
  const c = (typeof d.componentType === "string" ? (d.props ?? {}) : connector) as ServiceGraphNamingConfig;
  const naming: PrometheusNaming =
    exporter && "props" in exporter && typeof exporter.props === "object" ? (exporter.props as PrometheusNaming) : ((exporter ?? {}) as PrometheusNaming);
  const dimensions = [
    "client",
    "server",
    "connection_type",
    "failed",
    ...(c.dimensions ?? []).flatMap((dim) => [`client_${dim}`, `server_${dim}`]),
    ...(c.virtual_node_extra_label ? ["virtual_node"] : []),
  ];
  const metric = (n: string, type: "sum" | "histogram", unit?: string): CollectorMetric => ({
    name: `${SERVICEGRAPH_NAMESPACE}_${n}`,
    prometheus: prometheusMetricName(`${SERVICEGRAPH_NAMESPACE}_${n}`, type, unit, naming),
    type,
    ...(unit ? { unit } : {}),
    dimensions,
  });
  return {
    requests: metric("request_total", "sum"),
    failed: metric("request_failed_total", "sum"),
    serverDuration: metric("request_server", "histogram", "s"),
    clientDuration: metric("request_client", "histogram", "s"),
  };
}

// ── RED queries over span metrics ────────────────────────────────────
//
// The PromQL a RED dashboard and RED alerts share. They live here, next to
// the names they read, so the grafana lexicon (panels) and the prometheus
// lexicon (alerting rules) build the same expressions without either one
// importing the other.

/** A label matcher: `[label, op, value]`. */
export type PromMatcher = [label: string, op: "=" | "!=" | "=~" | "!~", value: string];

/** `metric{a="x", b=~"y"}`; just `metric` with no matchers. */
export function promSelector(metric: string, matchers: PromMatcher[]): string {
  if (matchers.length === 0) return metric;
  return `${metric}{${matchers.map(([l, op, v]) => `${l}${op}${JSON.stringify(v)}`).join(", ")}}`;
}

/** `sum by (labels) (rate(sel[range]))`, or `sum (...)` with no labels. */
export function promSumRate(sel: string, by: string[], range: string): string {
  return `sum${by.length ? ` by (${by.join(", ")})` : ""} (rate(${sel}[${range}]))`;
}

/**
 * `errors / all` as rates summed by `by`, with the numerator padded to zero:
 * `(errors or all * 0) / all`. A group with calls but no error series gets 0
 * instead of dropping out of the result.
 */
export function promErrorRatio(errorSel: string, allSel: string, by: string[], range: string): string {
  const all = promSumRate(allSel, by, range);
  return `(\n${promSumRate(errorSel, by, range)}\nor\n${all} * 0\n)\n/\n${all}`;
}

/** A number as PromQL writes it, without float noise. */
export function promNumber(n: number): string {
  return String(Number(n.toPrecision(10)));
}

/** `histogram_quantile(q, sum by (le, labels) (rate(bucket[range])))`. */
export function promQuantile(q: number, bucketSel: string, by: string[], range: string): string {
  return `histogram_quantile(${promNumber(q)}, ${promSumRate(bucketSel, ["le", ...by], range)})`;
}

/** The `span_kind` label values the spanmetrics connector writes. */
export type SpanMetricsKind =
  | "SPAN_KIND_UNSPECIFIED"
  | "SPAN_KIND_INTERNAL"
  | "SPAN_KIND_SERVER"
  | "SPAN_KIND_CLIENT"
  | "SPAN_KIND_PRODUCER"
  | "SPAN_KIND_CONSUMER";

/** Every `span_kind` value, in the order the spec lists them. */
export const SPAN_METRICS_KINDS: readonly SpanMetricsKind[] = Object.freeze([
  "SPAN_KIND_UNSPECIFIED",
  "SPAN_KIND_INTERNAL",
  "SPAN_KIND_SERVER",
  "SPAN_KIND_CLIENT",
  "SPAN_KIND_PRODUCER",
  "SPAN_KIND_CONSUMER",
]);

/** The kinds RED queries count unless told otherwise: the spans that serve a request or consume a message. */
export const RED_DEFAULT_SPAN_KINDS: readonly SpanMetricsKind[] = Object.freeze(["SPAN_KIND_SERVER", "SPAN_KIND_CONSUMER"]);

/** What `spanMetricsRedQueries` takes besides the names. */
export interface RedQueryOptions {
  /** The range every `rate` reads: `$__rate_interval` on a dashboard, `5m` in a rule. */
  range: string;
  /** Duration quantiles, one expression each (default p50, p95 and p99). */
  quantiles?: number[];
  /** A regex the service label must match, e.g. `$service`. Unset: no service matcher. */
  serviceMatch?: string;
  /**
   * The span kinds counted (default server and consumer spans). `[]` counts
   * every kind. With the default, a connector that excludes `span.kind`
   * gets no kind filter; naming kinds for such a connector is an error.
   */
  spanKinds?: readonly SpanMetricsKind[];
  /** Labels the results are split by besides the service label. */
  by?: string[];
  /** The name errors are reported under, e.g. `RedDashboard`. */
  owner?: string;
}

/** The RED expressions for one spanmetrics connector. */
export interface RedQueries {
  /** The service label the results are split by. */
  service: string;
  /** The span-kind matcher, or none. */
  kindMatchers: PromMatcher[];
  /** Counted spans per second. */
  rate: string;
  /** Errors over counted spans, 0 for a service with none. */
  errorRatio: string;
  /** One expression per quantile, in the histogram's unit. Empty when the connector has no histogram. */
  duration: Array<{ quantile: number; expr: string }>;
}

const DEFAULT_RED_QUANTILES = [0.5, 0.95, 0.99];

/**
 * The span-kind matcher for `kinds`, or none: none for `[]`, and none for
 * the default kinds when the connector excludes `span.kind`.
 */
export function spanKindMatchers(names: SpanMetricsNames, kinds: readonly SpanMetricsKind[] | undefined, owner = "spanKindMatchers"): PromMatcher[] {
  const label = names.labels.spanKind;
  if (kinds === undefined) return label ? [[label, "=~", RED_DEFAULT_SPAN_KINDS.join("|")]] : [];
  for (const k of kinds) {
    if (!SPAN_METRICS_KINDS.includes(k)) throw new Error(`${owner}: unknown span kind ${JSON.stringify(k)}; use one of ${SPAN_METRICS_KINDS.join(", ")}`);
  }
  if (kinds.length === 0) return [];
  if (!label) throw new Error(`${owner}: the connector excludes span.kind, so the metrics can't be filtered by spanKinds`);
  return [[label, "=~", [...new Set(kinds)].join("|")]];
}

/**
 * Rate, error ratio and duration quantiles per service, from a spanmetrics
 * connector's names. The grafana lexicon's `RedDashboard` and the prometheus
 * lexicon's `RedAlerts` both build their queries here.
 */
export function spanMetricsRedQueries(names: SpanMetricsNames, options: RedQueryOptions): RedQueries {
  const owner = options.owner ?? "spanMetricsRedQueries";
  const svc = names.labels.service;
  const status = names.labels.statusCode;
  if (!svc) throw new Error(`${owner}: the connector excludes service.name, so there is no service to break the metrics down by`);
  if (!status) throw new Error(`${owner}: the connector excludes status.code, so errors can't be told from successes`);
  const kind = spanKindMatchers(names, options.spanKinds, owner);
  const scope: PromMatcher[] = [...(options.serviceMatch !== undefined ? [[svc, "=~", options.serviceMatch] as PromMatcher] : []), ...kind];
  const by = [svc, ...(options.by ?? [])];
  const calls = promSelector(names.calls.prometheus, scope);
  const errors = promSelector(names.calls.prometheus, [...scope, [status, "=", names.errorStatus]]);
  const buckets = names.duration ? promSelector(`${names.duration.prometheus}_bucket`, scope) : undefined;
  const quantiles = options.quantiles ?? DEFAULT_RED_QUANTILES;
  return {
    service: svc,
    kindMatchers: kind,
    rate: promSumRate(calls, by, options.range),
    errorRatio: promErrorRatio(errors, calls, by, options.range),
    duration: buckets ? quantiles.map((q) => ({ quantile: q, expr: promQuantile(q, buckets, by, options.range) })) : [],
  };
}
