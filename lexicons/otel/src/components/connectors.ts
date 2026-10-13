/**
 * Built-in connectors: spanmetrics, servicegraph, routing, forward, count, sum,
 * signaltometrics.
 *
 * A connector is an exporter in one pipeline and a receiver in another. Put
 * the same entity in `exporters` of the pipeline that feeds it and in
 * `receivers` of the pipeline it feeds. `connects` lists the signal pairs each
 * connector's factory registers; OTEL112 checks pipelines against them.
 */

import { defineBuiltin } from "../define";
import type { ConnectorSignalPair } from "../model";
import type { Duration } from "./common";

const SAME_SIGNAL: ConnectorSignalPair[] = [
  { from: "traces", to: "traces" },
  { from: "metrics", to: "metrics" },
  { from: "logs", to: "logs" },
];

// ── spanmetrics ──────────────────────────────────────────────────────

/** A span or resource attribute added as a metric dimension. */
export interface SpanMetricsDimension {
  name: string;
  /** Value used when the attribute is missing. Without it, spans lacking the attribute get no dimension. */
  default?: string;
}

export interface SpanMetricsConnectorConfig {
  /** Extra dimensions on every metric, beyond service.name, span.name, span.kind and status.code. */
  dimensions?: SpanMetricsDimension[];
  /** Extra dimensions on the calls metric only. */
  calls_dimensions?: SpanMetricsDimension[];
  /** Default dimensions to leave out. */
  exclude_dimensions?: string[];
  resource_metrics_cache_size?: number;
  /** Resource attributes that key the metrics' resource, so a restart doesn't start a new series. */
  resource_metrics_key_attributes?: string[];
  aggregation_temporality?: "AGGREGATION_TEMPORALITY_CUMULATIVE" | "AGGREGATION_TEMPORALITY_DELTA";
  histogram?: {
    disable?: boolean;
    unit?: "ms" | "s";
    /** Explicit bucket boundaries. Set this or `exponential`, not both. */
    explicit?: { buckets?: Duration[] };
    exponential?: { max_size?: number };
    /** Extra dimensions on the duration histogram only. */
    dimensions?: SpanMetricsDimension[];
  };
  /** How often metrics are emitted (default 60s). */
  metrics_flush_interval?: Duration;
  /** Drop a series not updated for this long. */
  metrics_expiration?: Duration;
  metric_timestamp_cache_size?: number;
  /** Prefix for the emitted metric names (default `traces.span.metrics`). */
  namespace?: string;
  exemplars?: { enabled?: boolean; max_per_data_point?: number };
  /** Also count span events. Needs `dimensions` when enabled. */
  events?: { enabled?: boolean; dimensions?: SpanMetricsDimension[] };
  include_instrumentation_scope?: string[];
  aggregation_cardinality_limit?: number;
}

/** Turns spans into request, error and duration (RED) metrics. */
export const SpanMetricsConnector = defineBuiltin<SpanMetricsConnectorConfig, "connector", "spanmetrics">({
  kind: "connector",
  type: "spanmetrics",
  description: "Turns spans into call-count and duration metrics per service, span name, kind and status",
  connects: [{ from: "traces", to: "metrics" }],
  validate: (c) => {
    const problems: string[] = [];
    if (c.histogram?.explicit && c.histogram?.exponential) {
      problems.push("histogram: set explicit or exponential buckets, not both");
    }
    if (c.events?.enabled && (c.events.dimensions ?? []).length === 0) {
      problems.push("events: enabled needs at least one dimension");
    }
    const reserved = new Set(["service.name", "span.name", "span.kind", "status.code"]);
    for (const d of c.dimensions ?? []) {
      if (reserved.has(d.name)) problems.push(`dimensions: "${d.name}" is already a default dimension`);
      reserved.add(d.name);
    }
    return problems;
  },
});

// ── servicegraph ─────────────────────────────────────────────────────

export interface ServiceGraphConnectorConfig {
  latency_histogram_buckets?: Duration[];
  /** Span attributes added as dimensions on the edge metrics. */
  dimensions?: string[];
  /** How long an unpaired client or server span waits for its other half. */
  store?: { ttl?: Duration; max_items?: number };
  cache_loop?: Duration;
  store_expiration_loop?: Duration;
  /** Attributes that name the peer when only one side of a call is instrumented. */
  virtual_node_peer_attributes?: string[];
  virtual_node_extra_label?: boolean;
  metrics_flush_interval?: Duration;
  /** Attributes that name the database for a database call edge. */
  database_name_attributes?: string[];
}

/** Builds service-to-service edge metrics from paired client and server spans. */
export const ServiceGraphConnector = defineBuiltin<ServiceGraphConnectorConfig, "connector", "servicegraph">({
  kind: "connector",
  type: "servicegraph",
  description: "Builds service-to-service request and latency metrics from paired client and server spans",
  connects: [{ from: "traces", to: "metrics" }],
});

// ── routing ──────────────────────────────────────────────────────────

export interface RoutingTableItem {
  /** The OTTL context the condition runs in. `request` routes on request metadata such as headers. */
  context?: "resource" | "span" | "metric" | "datapoint" | "log" | "request";
  /** An OTTL `route() where ...` statement. Set this or `condition`, not both. */
  statement?: string;
  /** An OTTL condition. Set this or `statement`, not both. */
  condition?: string;
  /** Pipeline ids (`traces/tenant-a`) that receive matching data. Each must list this connector as a receiver. */
  pipelines: string[];
}

export interface RoutingConnectorConfig {
  table: RoutingTableItem[];
  /** Pipelines for data no route matches. */
  default_pipelines?: string[];
  error_mode?: "ignore" | "silent" | "propagate";
}

/** Sends each item to the pipelines whose route matches it. */
export const RoutingConnector = defineBuiltin<RoutingConnectorConfig, "connector", "routing">({
  kind: "connector",
  type: "routing",
  description: "Routes traces, metrics or logs to pipelines by OTTL condition",
  connects: SAME_SIGNAL,
  validate: (c) => {
    const problems: string[] = [];
    if ((c.table ?? []).length === 0) problems.push("table is empty");
    (c.table ?? []).forEach((item, i) => {
      if (!item.statement && !item.condition) problems.push(`table[${i}]: set a condition or a statement`);
      if (item.statement && item.condition) problems.push(`table[${i}]: set a condition or a statement, not both`);
      if (item.context === "request" && !item.condition) problems.push(`table[${i}]: the request context needs a condition`);
      if ((item.pipelines ?? []).length === 0) problems.push(`table[${i}]: no pipelines`);
    });
    return problems;
  },
});

// ── forward ──────────────────────────────────────────────────────────

export interface ForwardConnectorConfig {}

/** Passes data unchanged from one pipeline to another of the same signal. */
export const ForwardConnector = defineBuiltin<ForwardConnectorConfig, "connector", "forward">({
  kind: "connector",
  type: "forward",
  description: "Passes data unchanged to another pipeline of the same signal",
  connects: SAME_SIGNAL,
});

// ── count ────────────────────────────────────────────────────────────

export interface CountMetricInfo {
  description?: string;
  /** OTTL conditions; an item is counted when any matches. None counts every item. */
  conditions?: string[];
  /** Attributes to split the count by. Not supported for `metrics`. */
  attributes?: Array<{ key: string; default_value?: string | number | boolean }>;
}

/** Each key is the name of a metric to emit. */
export interface CountConnectorConfig {
  spans?: Record<string, CountMetricInfo>;
  spanevents?: Record<string, CountMetricInfo>;
  metrics?: Record<string, CountMetricInfo>;
  datapoints?: Record<string, CountMetricInfo>;
  logs?: Record<string, CountMetricInfo>;
  profiles?: Record<string, CountMetricInfo>;
}

/** Counts spans, span events, metrics, data points or log records, as metrics. */
export const CountConnector = defineBuiltin<CountConnectorConfig, "connector", "count">({
  kind: "connector",
  type: "count",
  description: "Counts spans, span events, metrics, data points or log records and emits the counts as metrics",
  connects: [
    { from: "traces", to: "metrics" },
    { from: "metrics", to: "metrics" },
    { from: "logs", to: "metrics" },
    { from: "profiles", to: "metrics" },
  ],
  validate: (c) => {
    const problems: string[] = [];
    for (const [section, metrics] of Object.entries(c) as Array<[string, Record<string, CountMetricInfo> | undefined]>) {
      for (const [name, info] of Object.entries(metrics ?? {})) {
        if (name === "") problems.push(`${section}: metric name missing`);
        if (section === "metrics" && (info?.attributes ?? []).length > 0) {
          problems.push(`metrics.${name}: attributes are not supported when counting metrics`);
        }
      }
    }
    return problems;
  },
});

// ── sum ──────────────────────────────────────────────────────────────

export interface SumMetricInfo {
  /** The attribute whose numeric value is summed. Strings that parse as numbers count; others are skipped. */
  source_attribute: string;
  description?: string;
  /** OTTL conditions; an item is summed when any matches. None sums every item that has the attribute. */
  conditions?: string[];
  /**
   * Attributes to split the sum by. Not supported for `metrics`. An item
   * missing one of them is skipped unless it has a `default_value`. Use at
   * most one: with more, the pinned collector adds each value once per
   * attribute (OTEL107 reports it).
   */
  attributes?: Array<{ key: string; default_value?: string | number | boolean }>;
}

/**
 * Each key is the name of a metric to emit. The connector emits monotonic
 * sums with delta temporality; the `prometheus` exporter accumulates them,
 * while an exporter that needs cumulative input wants a `deltatocumulative`
 * processor in front of it.
 */
export interface SumConnectorConfig {
  spans?: Record<string, SumMetricInfo>;
  spanevents?: Record<string, SumMetricInfo>;
  metrics?: Record<string, SumMetricInfo>;
  datapoints?: Record<string, SumMetricInfo>;
  logs?: Record<string, SumMetricInfo>;
}

/** Sums a numeric attribute of spans, span events, data points or log records, as metrics. */
export const SumConnector = defineBuiltin<SumConnectorConfig, "connector", "sum">({
  kind: "connector",
  type: "sum",
  description: "Sums a numeric attribute of spans, span events, data points or log records and emits the sums as metrics",
  connects: [
    { from: "traces", to: "metrics" },
    { from: "metrics", to: "metrics" },
    { from: "logs", to: "metrics" },
  ],
  validate: (c) => {
    const problems: string[] = [];
    let total = 0;
    for (const [section, metrics] of Object.entries(c) as Array<[string, Record<string, SumMetricInfo> | undefined]>) {
      for (const [name, info] of Object.entries(metrics ?? {})) {
        total++;
        if (name === "") problems.push(`${section}: metric name missing`);
        if (!info?.source_attribute) problems.push(`${section}.${name}: source_attribute is missing`);
        if (section === "metrics" && (info?.attributes ?? []).length > 0) {
          problems.push(`${section}.${name}: attributes are not supported when summing metrics`);
        }
        (info?.attributes ?? []).forEach((a, i) => {
          if (!a.key) problems.push(`${section}.${name}.attributes[${i}]: key is missing`);
        });
        // At the pinned release the connector adds each value once per
        // attribute key (sumconnector summer.increment), so two keys double
        // every sum.
        if ((info?.attributes ?? []).length > 1) {
          problems.push(
            `${section}.${name}: more than one attribute multiplies each sum by the number of attributes in the pinned collector; split by one attribute`,
          );
        }
      }
    }
    if (total === 0) problems.push("no metric is configured, so the connector emits nothing");
    return problems;
  },
});

// ── signaltometrics ──────────────────────────────────────────────────
//
// Typed against connector/signaltometricsconnector at COLLECTOR_PIN
// (collector-contrib v0.130.0): config/config.go and README.md at that tag,
// https://github.com/open-telemetry/opentelemetry-collector-contrib/tree/v0.130.0/connector/signaltometricsconnector
// The collector type is `signaltometrics`. Upstream marks every signal pair
// alpha. At v0.130.0 there is no span event section; spans, data points,
// logs and profiles each take a list of metrics.

/** The input sections of a `signaltometrics` connector, one per signal it reads. */
export const SIGNAL_TO_METRICS_SIGNALS = ["spans", "datapoints", "logs", "profiles"] as const;
export type SignalToMetricsSignal = (typeof SIGNAL_TO_METRICS_SIGNALS)[number];

/** The metric types a `signaltometrics` entry can produce. Each entry names exactly one. */
export const SIGNAL_TO_METRICS_TYPES = ["sum", "gauge", "histogram", "exponential_histogram"] as const;
export type SignalToMetricsType = (typeof SIGNAL_TO_METRICS_TYPES)[number];

/**
 * The connector's default explicit histogram bounds, used when `histogram`
 * sets no `buckets`. They are plain numbers in whatever unit `value` returns,
 * not durations.
 */
export const SIGNAL_TO_METRICS_DEFAULT_BUCKETS: readonly number[] = Object.freeze([
  2, 4, 6, 8, 10, 50, 100, 200, 400, 800, 1000, 1400, 2000, 5000, 10_000, 15_000,
]);

/**
 * An attribute of the produced metric.
 *
 * In `attributes`: without `default_value` or `optional`, an item lacking the
 * attribute is not counted at all; with `default_value`, it is counted under
 * that value; with `optional: true`, it is counted without the attribute.
 * Set at most one of the two.
 *
 * In `include_resource_attributes`: an include list. `default_value` fills a
 * missing resource attribute; `optional` changes nothing.
 */
export interface SignalToMetricsAttribute {
  key: string;
  default_value?: string | number | boolean;
  optional?: boolean;
}

/** A delta sum of `value` over the items in each batch. */
export interface SignalToMetricsSum {
  /** OTTL value expression; its result type (int or double) is the sum's. A constant is a string: `"1"`. */
  value: string;
}

/** The last `value` seen in each batch. */
export interface SignalToMetricsGauge {
  /** OTTL value expression. With `ExtractGrokPatterns`, select one key: `ExtractGrokPatterns(...)["key"]`. */
  value: string;
}

/** An explicit-bucket histogram of `value`. */
export interface SignalToMetricsHistogram {
  /** Upper bounds, increasing, in the unit `value` returns. Default `SIGNAL_TO_METRICS_DEFAULT_BUCKETS`. */
  buckets?: number[];
  /** OTTL value expression for how many observations each item counts as. Default: one per item. */
  count?: string;
  /** OTTL value expression for the observed value, e.g. `Seconds(end_time - start_time)` or an attribute. */
  value: string;
}

/** A base-2 exponential histogram of `value`. */
export interface SignalToMetricsExponentialHistogram {
  /** Buckets per positive or negative range, 2 to 16384. Default 160. */
  max_size?: number;
  /** OTTL value expression for how many observations each item counts as. Default: one per item. */
  count?: string;
  /** OTTL value expression for the observed value. */
  value: string;
}

/** What every `signaltometrics` entry has, whatever metric type it produces. */
export interface SignalToMetricsMetricBase {
  /** The OTLP metric name, used as written. */
  name: string;
  description?: string;
  /** The metric's unit, e.g. `s` or `{token}`. */
  unit?: string;
  /** Resource attributes the metric keeps. Unset or empty keeps them all. */
  include_resource_attributes?: SignalToMetricsAttribute[];
  /** Attributes of the item (span, data point, log record) the metric is split by. Unset: no attributes. */
  attributes?: SignalToMetricsAttribute[];
  /** OTTL conditions, ORed; an item counts when any matches. Unset counts every item. */
  conditions?: string[];
}

type OneMetricType<K extends SignalToMetricsType, V> = { [P in K]: V } & { [P in Exclude<SignalToMetricsType, K>]?: never };

/** One metric a `signaltometrics` connector produces: a name and exactly one metric type. */
export type SignalToMetricsMetric = SignalToMetricsMetricBase &
  (
    | OneMetricType<"sum", SignalToMetricsSum>
    | OneMetricType<"gauge", SignalToMetricsGauge>
    | OneMetricType<"histogram", SignalToMetricsHistogram>
    | OneMetricType<"exponential_histogram", SignalToMetricsExponentialHistogram>
  );

/**
 * The metrics to produce, per input signal. The connector emits delta
 * temporality and aggregates only within each batch it receives, so an
 * exporter that needs cumulative input (Prometheus remote write) wants a
 * `deltatocumulative` processor in front of it.
 */
export interface SignalToMetricsConnectorConfig {
  spans?: SignalToMetricsMetric[];
  datapoints?: SignalToMetricsMetric[];
  logs?: SignalToMetricsMetric[];
  profiles?: SignalToMetricsMetric[];
}

/** One entry of a `signaltometrics` config, with where it sits. */
export interface SignalToMetricsEntry {
  signal: SignalToMetricsSignal;
  index: number;
  metric: SignalToMetricsMetric;
  /** The metric types the entry names. A valid entry names exactly one. */
  types: SignalToMetricsType[];
}

/** Every metric entry of a `signaltometrics` config, in section order. Reads untyped config too. */
export function signalToMetricsEntries(config: SignalToMetricsConnectorConfig): SignalToMetricsEntry[] {
  const out: SignalToMetricsEntry[] = [];
  for (const signal of SIGNAL_TO_METRICS_SIGNALS) {
    const list = (config as Record<string, unknown>)?.[signal];
    if (!Array.isArray(list)) continue;
    list.forEach((metric, index) => {
      const m = (metric ?? {}) as Record<string, unknown>;
      const types = SIGNAL_TO_METRICS_TYPES.filter((t) => m[t] !== undefined && m[t] !== null);
      out.push({ signal, index, metric: m as unknown as SignalToMetricsMetric, types });
    });
  }
  return out;
}

const GROK_KEY_SELECTOR = /ExtractGrokPatterns\([^)]*\)\s*\[[^\]]+\]/;

/** The checks config/config.go makes at v0.130.0 that need no OTTL parser, plus increasing buckets. */
function validateSignalToMetrics(c: SignalToMetricsConnectorConfig): string[] {
  const problems: string[] = [];
  const entries = signalToMetricsEntries(c);
  if (entries.length === 0) {
    problems.push("no metric is configured under spans, datapoints, logs or profiles; the collector refuses the connector");
  }
  for (const { signal, index, metric, types } of entries) {
    const m = metric as unknown as SignalToMetricsMetricBase & Partial<Record<SignalToMetricsType, Record<string, unknown>>>;
    const at = m.name ? `${signal}[${index}] (${m.name})` : `${signal}[${index}]`;
    if (!m.name) problems.push(`${at}: name is missing`);
    if (types.length !== 1) {
      problems.push(
        `${at}: name exactly one metric type (sum, gauge, histogram or exponential_histogram); ${types.length === 0 ? "found none" : `found ${types.join(" and ")}`}`,
      );
    }
    for (const t of types) {
      const body = m[t];
      if (typeof body?.value !== "string" || body.value === "") problems.push(`${at}: ${t}.value is missing`);
    }
    const buckets = m.histogram?.buckets;
    if (Array.isArray(buckets) && buckets.some((b, i) => i > 0 && !((b as number) > (buckets[i - 1] as number)))) {
      problems.push(`${at}: histogram.buckets must increase`);
    }
    const maxSize = m.exponential_histogram?.max_size;
    if (typeof maxSize === "number" && maxSize !== 0 && (maxSize < 2 || maxSize > 16384)) {
      problems.push(`${at}: exponential_histogram.max_size must be between 2 and 16384`);
    }
    const gauge = m.gauge?.value;
    if (typeof gauge === "string" && gauge.includes("ExtractGrokPatterns") && !GROK_KEY_SELECTOR.test(gauge)) {
      problems.push(`${at}: gauge.value with ExtractGrokPatterns needs one key selector, ExtractGrokPatterns(...)["key"]`);
    }
    const seen = new Set<string>();
    (m.attributes ?? []).forEach((a, i) => {
      if (!a?.key) {
        problems.push(`${at}: attributes[${i}]: key is missing`);
        return;
      }
      if (a.default_value !== undefined && a.optional) {
        problems.push(`${at}: attributes "${a.key}": set default_value or optional, not both`);
      }
      if (seen.has(a.key)) problems.push(`${at}: attributes "${a.key}" is listed twice`);
      seen.add(a.key);
    });
  }
  return problems;
}

/**
 * Builds metrics from spans, data points, logs or profiles, each with the
 * name, type, unit, attributes and conditions you choose. A histogram, sum or
 * gauge takes its value from an OTTL expression, such as an attribute or the
 * span's duration.
 */
export const SignalToMetricsConnector = defineBuiltin<SignalToMetricsConnectorConfig, "connector", "signaltometrics">({
  kind: "connector",
  type: "signaltometrics",
  description: "Builds named sum, gauge and histogram metrics from spans, data points, logs or profiles, with values and conditions in OTTL",
  connects: [
    { from: "traces", to: "metrics" },
    { from: "metrics", to: "metrics" },
    { from: "logs", to: "metrics" },
    { from: "profiles", to: "metrics" },
  ],
  validate: validateSignalToMetrics,
});
