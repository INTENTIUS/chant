/**
 * Built-in connectors: spanmetrics, servicegraph, routing, forward, count.
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
