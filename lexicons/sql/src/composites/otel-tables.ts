/**
 * `OtelTables`: the tables the OpenTelemetry Collector's `clickhouse` exporter writes, declared here so the exporter can run with `create_schema: false`.
 *
 * The DDL follows the exporter's own create statements at
 * opentelemetry-collector-contrib v0.130.0, the otel lexicon's
 * `COLLECTOR_PIN`, column for column:
 *
 * - `exporter/clickhouseexporter/internal/sqltemplates/logs_table.sql`
 * - `exporter/clickhouseexporter/internal/sqltemplates/traces_table.sql`
 * - `exporter/clickhouseexporter/internal/sqltemplates/traces_id_ts_lookup_table.sql`
 * - `exporter/clickhouseexporter/internal/sqltemplates/traces_id_ts_lookup_mv.sql`
 * - `exporter/clickhouseexporter/internal/sqltemplates/metrics_gauge_table.sql`,
 *   `metrics_sum_table.sql`, `metrics_summary_table.sql`,
 *   `metrics_histogram_table.sql` and `metrics_exp_histogram_table.sql`
 *
 * The table names default to the exporter's (`exporter/clickhouseexporter/config.go`,
 * `createDefaultConfig`): `otel_logs`, `otel_traces` and `otel_metrics_<type>`.
 * The exponential histogram table is `otel_metrics_exponential_histogram`:
 * `defaultExpHistogramSuffix` in config.go is `_exponential_histogram`, though
 * the README's option list says `otel_metrics_exp_histogram`. The code decides.
 *
 * With `create_schema: true` the exporter's traces exporter also creates a
 * trace-id lookup table, `<traces>_trace_id_ts`, and a materialized view,
 * `<traces>_trace_id_ts_mv`, that fills it from the traces table
 * (`createTraceTables` in `exporter_traces.go`). The README's trace query
 * reads the lookup table to bound a trace's time range. Both are declared
 * here unless `traceIdLookup` is false.
 *
 * What differs from the exporter's DDL, none of it a column:
 *
 * - The engine is `MergeTree`, the exporter's default `table_engine`. A
 *   replicated setup declares its own tables.
 * - `IF NOT EXISTS` and `ON CLUSTER` are left out; the sql lexicon plans the
 *   tables instead.
 * - The metrics templates put `TTL` before `PARTITION BY`; here it follows
 *   `ORDER BY`, as in the logs and traces templates. ClickHouse reads the
 *   clauses the same in either order.
 * - The exporter's JSON tables (`logs_json_table.sql`, `traces_json_table.sql`)
 *   are used only behind the `clickhouse.json` feature gate (alpha, off by
 *   default, `factory.go`) and are not declared.
 *
 * The database is not declared. Unqualified, the tables are created in the
 * server's `default` database, which is the exporter's default `database`.
 */

import { Composite } from "@intentius/chant/composite";
import { table, view, type ClickHouseTable, type ClickHouseView } from "../clickhouse/entities";

/** The table names the exporter writes, by its config key. Each defaults to the exporter's. */
export interface OtelTableNames {
  /** `logs_table_name` (default `otel_logs`). */
  logs?: string;
  /** `traces_table_name` (default `otel_traces`). */
  traces?: string;
  /** `metrics_tables.gauge.name` (default `otel_metrics_gauge`). */
  gauge?: string;
  /** `metrics_tables.sum.name` (default `otel_metrics_sum`). */
  sum?: string;
  /** `metrics_tables.summary.name` (default `otel_metrics_summary`). */
  summary?: string;
  /** `metrics_tables.histogram.name` (default `otel_metrics_histogram`). */
  histogram?: string;
  /** `metrics_tables.exponential_histogram.name` (default `otel_metrics_exponential_histogram`). */
  exponentialHistogram?: string;
}

export interface OtelTablesProps {
  /** The database the tables are created in, the exporter's `database`. Unset, the names are unqualified and land in `default`. */
  database?: string;
  /**
   * How long rows are kept, as the exporter's `ttl` takes it: a Go duration
   * such as `72h` or `30m`. Rendered the way the exporter renders it
   * (`GenerateTTLExpr` in `internal/clickhouse.go`): whole days as
   * `toIntervalDay`, else hours, minutes or seconds. Unset or zero, no TTL.
   */
  ttl?: string;
  /** Table names other than the exporter's defaults, as set on the exporter. */
  tables?: OtelTableNames;
  /** Declare the trace-id lookup table and its materialized view (default true). */
  traceIdLookup?: boolean;
}

export type OtelTablesMembers = {
  logs: ClickHouseTable;
  traces: ClickHouseTable;
  /** `<traces>_trace_id_ts`, absent when `traceIdLookup` is false. */
  traceIdTs?: ClickHouseTable;
  /** `<traces>_trace_id_ts_mv`, absent when `traceIdLookup` is false. */
  traceIdTsView?: ClickHouseView;
  metricsGauge: ClickHouseTable;
  metricsSum: ClickHouseTable;
  metricsSummary: ClickHouseTable;
  metricsHistogram: ClickHouseTable;
  metricsExponentialHistogram: ClickHouseTable;
};

/** The exporter's default table names at v0.130.0 (`createDefaultConfig` in `config.go`). */
export const OTEL_EXPORTER_DEFAULT_TABLES: Readonly<Required<OtelTableNames>> = Object.freeze({
  logs: "otel_logs",
  traces: "otel_traces",
  gauge: "otel_metrics_gauge",
  sum: "otel_metrics_sum",
  summary: "otel_metrics_summary",
  histogram: "otel_metrics_histogram",
  exponentialHistogram: "otel_metrics_exponential_histogram",
});

const GO_UNITS_S: Record<string, number> = { ns: 1e-9, us: 1e-6, "µs": 1e-6, "μs": 1e-6, ms: 1e-3, s: 1, m: 60, h: 3600 };

/** A Go duration in whole seconds, or an error naming the value. Go's `time.ParseDuration` has no day unit. */
function goDurationSeconds(d: string): number {
  const text = d.trim();
  if (/^0$/.test(text)) return 0;
  if (!/^((\d+(\.\d*)?|\.\d+)(ns|us|µs|μs|ms|s|m|h))+$/.test(text)) {
    throw new Error(`OtelTables: ttl ${JSON.stringify(d)} is not a Go duration such as 72h or 30m`);
  }
  let total = 0;
  for (const part of text.matchAll(/(\d+(?:\.\d*)?|\.\d+)(ns|us|µs|μs|ms|s|m|h)/g)) total += Number(part[1]) * GO_UNITS_S[part[2]!]!;
  return Math.floor(total);
}

/**
 * The TTL clause the exporter writes for `ttl` over `timeField`, or "" for none
 * (`GenerateTTLExpr` in `internal/clickhouse.go` at v0.130.0).
 */
export function otelTtlClause(ttl: string | undefined, timeField: string): string {
  if (ttl === undefined) return "";
  const s = goDurationSeconds(ttl);
  if (s <= 0) return "";
  if (s % 86400 === 0) return `TTL ${timeField} + toIntervalDay(${s / 86400})`;
  if (s % 3600 === 0) return `TTL ${timeField} + toIntervalHour(${s / 3600})`;
  if (s % 60 === 0) return `TTL ${timeField} + toIntervalMinute(${s / 60})`;
  return `TTL ${timeField} + toIntervalSecond(${s})`;
}

// The column lists of the exporter's create statements, as written there.

const METRIC_HEAD = `
    ResourceAttributes Map(LowCardinality(String), String) CODEC(ZSTD(1)),
    ResourceSchemaUrl String CODEC(ZSTD(1)),
    ScopeName String CODEC(ZSTD(1)),
    ScopeVersion String CODEC(ZSTD(1)),
    ScopeAttributes Map(LowCardinality(String), String) CODEC(ZSTD(1)),
    ScopeDroppedAttrCount UInt32 CODEC(ZSTD(1)),
    ScopeSchemaUrl String CODEC(ZSTD(1)),
    ServiceName LowCardinality(String) CODEC(ZSTD(1)),
    MetricName String CODEC(ZSTD(1)),
    MetricDescription String CODEC(ZSTD(1)),
    MetricUnit String CODEC(ZSTD(1)),
    Attributes Map(LowCardinality(String), String) CODEC(ZSTD(1)),
    StartTimeUnix DateTime64(9) CODEC(Delta, ZSTD(1)),
    TimeUnix DateTime64(9) CODEC(Delta, ZSTD(1)),`;

const EXEMPLARS = `
    Exemplars Nested (
      FilteredAttributes Map(LowCardinality(String), String),
      TimeUnix DateTime64(9),
      Value Float64,
      SpanId String,
      TraceId String
    ) CODEC(ZSTD(1)),`;

const METRIC_INDEXES = `
    INDEX idx_res_attr_key mapKeys(ResourceAttributes) TYPE bloom_filter(0.01) GRANULARITY 1,
    INDEX idx_res_attr_value mapValues(ResourceAttributes) TYPE bloom_filter(0.01) GRANULARITY 1,
    INDEX idx_scope_attr_key mapKeys(ScopeAttributes) TYPE bloom_filter(0.01) GRANULARITY 1,
    INDEX idx_scope_attr_value mapValues(ScopeAttributes) TYPE bloom_filter(0.01) GRANULARITY 1,
    INDEX idx_attr_key mapKeys(Attributes) TYPE bloom_filter(0.01) GRANULARITY 1,
    INDEX idx_attr_value mapValues(Attributes) TYPE bloom_filter(0.01) GRANULARITY 1`;

/** The columns each metric table adds between the shared head and the indexes. */
const METRIC_BODIES = {
  gauge: `
    Value Float64 CODEC(ZSTD(1)),
    Flags UInt32 CODEC(ZSTD(1)),${EXEMPLARS}`,
  sum: `
    Value Float64 CODEC(ZSTD(1)),
    Flags UInt32 CODEC(ZSTD(1)),${EXEMPLARS}
    AggregationTemporality Int32 CODEC(ZSTD(1)),
    IsMonotonic Boolean CODEC(Delta, ZSTD(1)),`,
  summary: `
    Count UInt64 CODEC(Delta, ZSTD(1)),
    Sum Float64 CODEC(ZSTD(1)),
    ValueAtQuantiles Nested (
      Quantile Float64,
      Value Float64
    ) CODEC(ZSTD(1)),
    Flags UInt32 CODEC(ZSTD(1)),`,
  histogram: `
    Count UInt64 CODEC(Delta, ZSTD(1)),
    Sum Float64 CODEC(ZSTD(1)),
    BucketCounts Array(UInt64) CODEC(ZSTD(1)),
    ExplicitBounds Array(Float64) CODEC(ZSTD(1)),${EXEMPLARS}
    Flags UInt32 CODEC(ZSTD(1)),
    Min Float64 CODEC(ZSTD(1)),
    Max Float64 CODEC(ZSTD(1)),
    AggregationTemporality Int32 CODEC(ZSTD(1)),`,
  exponentialHistogram: `
    Count UInt64 CODEC(Delta, ZSTD(1)),
    Sum Float64 CODEC(ZSTD(1)),
    Scale Int32 CODEC(ZSTD(1)),
    ZeroCount UInt64 CODEC(ZSTD(1)),
    PositiveOffset Int32 CODEC(ZSTD(1)),
    PositiveBucketCounts Array(UInt64) CODEC(ZSTD(1)),
    NegativeOffset Int32 CODEC(ZSTD(1)),
    NegativeBucketCounts Array(UInt64) CODEC(ZSTD(1)),${EXEMPLARS}
    Flags UInt32 CODEC(ZSTD(1)),
    Min Float64 CODEC(ZSTD(1)),
    Max Float64 CODEC(ZSTD(1)),
    AggregationTemporality Int32 CODEC(ZSTD(1)),`,
} as const;

/** The logs, traces and metrics tables the OpenTelemetry Collector's clickhouse exporter writes, as it creates them at v0.130.0. */
export const OtelTables = Composite<OtelTablesProps, OtelTablesMembers>((props) => {
  const names = { ...OTEL_EXPORTER_DEFAULT_TABLES, ...props.tables };
  const q = (name: string) => (props.database ? `${props.database}.${name}` : name);
  const ttl = (field: string) => otelTtlClause(props.ttl, field);

  const logs = table`
    CREATE TABLE ${q(names.logs)} (
      Timestamp DateTime64(9) CODEC(Delta(8), ZSTD(1)),
      TimestampTime DateTime DEFAULT toDateTime(Timestamp),
      TraceId String CODEC(ZSTD(1)),
      SpanId String CODEC(ZSTD(1)),
      TraceFlags UInt8,
      SeverityText LowCardinality(String) CODEC(ZSTD(1)),
      SeverityNumber UInt8,
      ServiceName LowCardinality(String) CODEC(ZSTD(1)),
      Body String CODEC(ZSTD(1)),
      ResourceSchemaUrl LowCardinality(String) CODEC(ZSTD(1)),
      ResourceAttributes Map(LowCardinality(String), String) CODEC(ZSTD(1)),
      ScopeSchemaUrl LowCardinality(String) CODEC(ZSTD(1)),
      ScopeName String CODEC(ZSTD(1)),
      ScopeVersion LowCardinality(String) CODEC(ZSTD(1)),
      ScopeAttributes Map(LowCardinality(String), String) CODEC(ZSTD(1)),
      LogAttributes Map(LowCardinality(String), String) CODEC(ZSTD(1)),
      INDEX idx_trace_id TraceId TYPE bloom_filter(0.001) GRANULARITY 1,
      INDEX idx_res_attr_key mapKeys(ResourceAttributes) TYPE bloom_filter(0.01) GRANULARITY 1,
      INDEX idx_res_attr_value mapValues(ResourceAttributes) TYPE bloom_filter(0.01) GRANULARITY 1,
      INDEX idx_scope_attr_key mapKeys(ScopeAttributes) TYPE bloom_filter(0.01) GRANULARITY 1,
      INDEX idx_scope_attr_value mapValues(ScopeAttributes) TYPE bloom_filter(0.01) GRANULARITY 1,
      INDEX idx_log_attr_key mapKeys(LogAttributes) TYPE bloom_filter(0.01) GRANULARITY 1,
      INDEX idx_log_attr_value mapValues(LogAttributes) TYPE bloom_filter(0.01) GRANULARITY 1,
      INDEX idx_body Body TYPE tokenbf_v1(32768, 3, 0) GRANULARITY 8
    )
    ENGINE = MergeTree
    PARTITION BY toDate(TimestampTime)
    PRIMARY KEY (ServiceName, TimestampTime)
    ORDER BY (ServiceName, TimestampTime, Timestamp)
    ${ttl("TimestampTime")}
    SETTINGS index_granularity = 8192, ttl_only_drop_parts = 1`;

  const traces = table`
    CREATE TABLE ${q(names.traces)} (
      Timestamp DateTime64(9) CODEC(Delta, ZSTD(1)),
      TraceId String CODEC(ZSTD(1)),
      SpanId String CODEC(ZSTD(1)),
      ParentSpanId String CODEC(ZSTD(1)),
      TraceState String CODEC(ZSTD(1)),
      SpanName LowCardinality(String) CODEC(ZSTD(1)),
      SpanKind LowCardinality(String) CODEC(ZSTD(1)),
      ServiceName LowCardinality(String) CODEC(ZSTD(1)),
      ResourceAttributes Map(LowCardinality(String), String) CODEC(ZSTD(1)),
      ScopeName String CODEC(ZSTD(1)),
      ScopeVersion String CODEC(ZSTD(1)),
      SpanAttributes Map(LowCardinality(String), String) CODEC(ZSTD(1)),
      Duration UInt64 CODEC(ZSTD(1)),
      StatusCode LowCardinality(String) CODEC(ZSTD(1)),
      StatusMessage String CODEC(ZSTD(1)),
      Events Nested (
        Timestamp DateTime64(9),
        Name LowCardinality(String),
        Attributes Map(LowCardinality(String), String)
      ) CODEC(ZSTD(1)),
      Links Nested (
        TraceId String,
        SpanId String,
        TraceState String,
        Attributes Map(LowCardinality(String), String)
      ) CODEC(ZSTD(1)),
      INDEX idx_trace_id TraceId TYPE bloom_filter(0.001) GRANULARITY 1,
      INDEX idx_res_attr_key mapKeys(ResourceAttributes) TYPE bloom_filter(0.01) GRANULARITY 1,
      INDEX idx_res_attr_value mapValues(ResourceAttributes) TYPE bloom_filter(0.01) GRANULARITY 1,
      INDEX idx_span_attr_key mapKeys(SpanAttributes) TYPE bloom_filter(0.01) GRANULARITY 1,
      INDEX idx_span_attr_value mapValues(SpanAttributes) TYPE bloom_filter(0.01) GRANULARITY 1,
      INDEX idx_duration Duration TYPE minmax GRANULARITY 1
    )
    ENGINE = MergeTree
    PARTITION BY toDate(Timestamp)
    ORDER BY (ServiceName, SpanName, toDateTime(Timestamp))
    ${ttl("toDateTime(Timestamp)")}
    SETTINGS index_granularity = 8192, ttl_only_drop_parts = 1`;

  const metric = (name: string, body: string) => table`
    CREATE TABLE ${q(name)} (${METRIC_HEAD}${body}${METRIC_INDEXES}
    )
    ENGINE = MergeTree
    PARTITION BY toDate(TimeUnix)
    ORDER BY (ServiceName, MetricName, Attributes, toUnixTimestamp64Nano(TimeUnix))
    ${ttl("toDateTime(TimeUnix)")}
    SETTINGS index_granularity = 8192, ttl_only_drop_parts = 1`;

  const members: OtelTablesMembers = {
    logs,
    traces,
    metricsGauge: metric(names.gauge, METRIC_BODIES.gauge),
    metricsSum: metric(names.sum, METRIC_BODIES.sum),
    metricsSummary: metric(names.summary, METRIC_BODIES.summary),
    metricsHistogram: metric(names.histogram, METRIC_BODIES.histogram),
    metricsExponentialHistogram: metric(names.exponentialHistogram, METRIC_BODIES.exponentialHistogram),
  };

  if (props.traceIdLookup !== false) {
    const traceIdTs = table`
      CREATE TABLE ${q(`${names.traces}_trace_id_ts`)} (
        TraceId String CODEC(ZSTD(1)),
        Start DateTime CODEC(Delta, ZSTD(1)),
        End DateTime CODEC(Delta, ZSTD(1)),
        INDEX idx_trace_id TraceId TYPE bloom_filter(0.01) GRANULARITY 1
      )
      ENGINE = MergeTree
      PARTITION BY toDate(Start)
      ORDER BY (TraceId, Start)
      ${ttl("toDateTime(Start)")}
      SETTINGS index_granularity = 8192, ttl_only_drop_parts = 1`;
    const traceIdTsView = view`
      CREATE MATERIALIZED VIEW ${q(`${names.traces}_trace_id_ts_mv`)} TO ${traceIdTs} AS
      SELECT
        TraceId,
        min(Timestamp) AS Start,
        max(Timestamp) AS End
      FROM ${traces}
      WHERE TraceId != ''
      GROUP BY TraceId`;
    members.traceIdTs = traceIdTs;
    members.traceIdTsView = traceIdTsView;
  }
  return members;
}, "OtelTables");
