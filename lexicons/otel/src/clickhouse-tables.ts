/**
 * The ClickHouse tables a `clickhouse` exporter writes (#4397), read from its
 * config the way the exporter reads it at `COLLECTOR_PIN` (contrib v0.130.0).
 * OTEL129 and the otel lexicon's `workspaceLinks` hook share this, so the
 * check in one build root and the link across workspace members agree on
 * which tables and columns an exporter needs.
 *
 * Sources in opentelemetry-collector-contrib at v0.130.0,
 * `exporter/clickhouseexporter/`:
 *
 * - Default names: `createDefaultConfig` and `buildMetricTableNames` in
 *   `config.go`. The exponential histogram table is
 *   `otel_metrics_exponential_histogram` there; the README says
 *   `otel_metrics_exp_histogram`, and the code is what runs.
 * - Database: `Config.database()` in `config.go`. `database` wins unless it
 *   is `default`, then the endpoint DSN's database, then `default`.
 * - Columns: the column lists of the insert statements in
 *   `internal/sqltemplates/*_insert.sql`. A `Nested` field such as
 *   `Events.Timestamp` is listed under its column, `Events`.
 * - Which tables a signal touches: each signal's exporter writes only its own
 *   tables (`exporter_logs.go`, `exporter_traces.go`, `exporter_metrics.go`),
 *   and only when a pipeline of that signal uses the exporter.
 * - `create_schema` defaults to true and makes the exporter run
 *   `CREATE TABLE IF NOT EXISTS` for its tables at start.
 *
 * The trace-id lookup table and its materialized view, which the traces
 * exporter creates beside the traces table when `create_schema` is true, are
 * not written by the exporter: the view fills the table from the traces
 * table's inserts. They are not part of what an exporter needs here.
 */

import type { CollectorConfig } from "./model";
import { parseComponentId, pipelineSignal } from "./model";

/** One table an exporter writes. */
export interface ClickHouseExporterTable {
  /** The signal whose pipeline writes it. */
  signal: "logs" | "traces" | "metrics";
  /** The config key that names it: `logs_table_name`, `metrics_tables.gauge.name`. */
  key: string;
  /** The table, as the exporter resolves it. */
  name: string;
  /** The columns its insert statement names. */
  columns: readonly string[];
}

/** What one `clickhouse` exporter writes. */
export interface ClickHouseExporterTargets {
  /** The exporter's id: `clickhouse` or `clickhouse/<name>`. */
  id: string;
  database: string;
  /** Whether the exporter creates its database and tables at start (`create_schema`, default true). */
  createSchema: boolean;
  tables: ClickHouseExporterTable[];
  /** Values chant can't read without the environment, such as `${env:CH_DB}`: the tables they name are left out. */
  unread: string[];
}

const METRIC_HEAD = [
  "ResourceAttributes",
  "ResourceSchemaUrl",
  "ScopeName",
  "ScopeVersion",
  "ScopeAttributes",
  "ScopeDroppedAttrCount",
  "ScopeSchemaUrl",
  "ServiceName",
  "MetricName",
  "MetricDescription",
  "MetricUnit",
  "Attributes",
  "StartTimeUnix",
  "TimeUnix",
] as const;

/** The columns each insert statement names, at v0.130.0. */
export const CLICKHOUSE_EXPORTER_COLUMNS = {
  logs: [
    "Timestamp",
    "TraceId",
    "SpanId",
    "TraceFlags",
    "SeverityText",
    "SeverityNumber",
    "ServiceName",
    "Body",
    "ResourceSchemaUrl",
    "ResourceAttributes",
    "ScopeSchemaUrl",
    "ScopeName",
    "ScopeVersion",
    "ScopeAttributes",
    "LogAttributes",
  ],
  traces: [
    "Timestamp",
    "TraceId",
    "SpanId",
    "ParentSpanId",
    "TraceState",
    "SpanName",
    "SpanKind",
    "ServiceName",
    "ResourceAttributes",
    "ScopeName",
    "ScopeVersion",
    "SpanAttributes",
    "Duration",
    "StatusCode",
    "StatusMessage",
    "Events",
    "Links",
  ],
  gauge: [...METRIC_HEAD, "Value", "Flags", "Exemplars"],
  sum: [...METRIC_HEAD, "Value", "Flags", "Exemplars", "AggregationTemporality", "IsMonotonic"],
  summary: [...METRIC_HEAD, "Count", "Sum", "ValueAtQuantiles", "Flags"],
  histogram: [...METRIC_HEAD, "Count", "Sum", "BucketCounts", "ExplicitBounds", "Exemplars", "Flags", "Min", "Max", "AggregationTemporality"],
  exponential_histogram: [
    ...METRIC_HEAD,
    "Count",
    "Sum",
    "Scale",
    "ZeroCount",
    "PositiveOffset",
    "PositiveBucketCounts",
    "NegativeOffset",
    "NegativeBucketCounts",
    "Exemplars",
    "Flags",
    "Min",
    "Max",
    "AggregationTemporality",
  ],
} as const satisfies Record<string, readonly string[]>;

/** The metric types in `metrics_tables`, with the suffix each default name takes. */
const METRIC_TYPES = [
  ["gauge", "_gauge"],
  ["sum", "_sum"],
  ["summary", "_summary"],
  ["histogram", "_histogram"],
  ["exponential_histogram", "_exponential_histogram"],
] as const;

const DEFAULT_DATABASE = "default";
const DEFAULT_METRICS_PREFIX = "otel_metrics";

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === "string" && v !== "" ? v : undefined);
/** A value the collector expands from the environment or another config source. */
const expanded = (v: string) => v.includes("${");

/** The database in the endpoint DSN's path, or undefined when it has none or can't be read. */
function dsnDatabase(endpoint: string | undefined): string | undefined {
  if (!endpoint || expanded(endpoint)) return undefined;
  try {
    const path = new URL(endpoint).pathname.replace(/^\/+/, "");
    return path === "" ? undefined : decodeURIComponent(path);
  } catch {
    return undefined;
  }
}

/** The signals whose pipelines list exporter `id`. */
export function exporterSignals(config: CollectorConfig, id: string): Set<string> {
  const out = new Set<string>();
  for (const [pid, p] of Object.entries(config.service?.pipelines ?? {})) {
    const exporters = isRecord(p) && Array.isArray(p.exporters) ? p.exporters : [];
    if (exporters.includes(id)) out.add(pipelineSignal(pid));
  }
  return out;
}

/**
 * The tables one `clickhouse` exporter writes, for the signals whose
 * pipelines use it. `raw` is its config block.
 */
export function clickhouseExporterTargets(id: string, raw: unknown, signals: ReadonlySet<string>): ClickHouseExporterTargets {
  const c = isRecord(raw) ? raw : {};
  const unread: string[] = [];

  let database = DEFAULT_DATABASE;
  const configured = str(c.database);
  if (configured && expanded(configured)) unread.push(`database ${configured}`);
  else if (configured && configured !== DEFAULT_DATABASE) database = configured;
  else {
    const endpoint = str(c.endpoint);
    if (endpoint && expanded(endpoint)) unread.push(`endpoint ${endpoint}, whose path may name the database`);
    database = dsnDatabase(endpoint) ?? DEFAULT_DATABASE;
  }
  if (unread.length > 0) return { id, database, createSchema: c.create_schema !== false, tables: [], unread };

  const tables: ClickHouseExporterTable[] = [];
  const add = (signal: ClickHouseExporterTable["signal"], key: string, name: string, columns: readonly string[]) => {
    if (expanded(name)) unread.push(`${key} ${name}`);
    else tables.push({ signal, key, name, columns });
  };
  if (signals.has("logs")) add("logs", "logs_table_name", str(c.logs_table_name) ?? "otel_logs", CLICKHOUSE_EXPORTER_COLUMNS.logs);
  if (signals.has("traces")) add("traces", "traces_table_name", str(c.traces_table_name) ?? "otel_traces", CLICKHOUSE_EXPORTER_COLUMNS.traces);
  if (signals.has("metrics")) {
    const mt = isRecord(c.metrics_tables) ? c.metrics_tables : {};
    const nameOf = (type: string) => (isRecord(mt[type]) ? str((mt[type] as Record<string, unknown>).name) : undefined);
    // The deprecated metrics_table_name is a prefix, used only when no metrics_tables name is set.
    const anySet = METRIC_TYPES.some(([type]) => nameOf(type) !== undefined);
    const prefix = !anySet ? (str(c.metrics_table_name) ?? DEFAULT_METRICS_PREFIX) : DEFAULT_METRICS_PREFIX;
    for (const [type, suffix] of METRIC_TYPES) {
      add("metrics", `metrics_tables.${type}.name`, nameOf(type) ?? `${prefix}${suffix}`, CLICKHOUSE_EXPORTER_COLUMNS[type]);
    }
  }
  return { id, database, createSchema: c.create_schema !== false, tables, unread };
}

/** Every `clickhouse` exporter a pipeline uses in `config`, with what it writes. */
export function clickhouseExportersOf(config: CollectorConfig): ClickHouseExporterTargets[] {
  const out: ClickHouseExporterTargets[] = [];
  for (const [id, raw] of Object.entries(config.exporters ?? {})) {
    if (parseComponentId(id)?.type !== "clickhouse") continue;
    const signals = exporterSignals(config, id);
    if (signals.size === 0) continue;
    out.push(clickhouseExporterTargets(id, raw, signals));
  }
  return out;
}
