/**
 * Built-in exporters: otlp, otlphttp, debug, prometheus, googlecloud, clickhouse.
 */

import { defineBuiltin } from "../define";
import type { Overlay, Require } from "./overlay";
import type { DebugExporterSchemaConfig, GoogleCloudExporterSchemaConfig, OtlpExporterSchemaConfig, OtlpHttpExporterSchemaConfig, PrometheusExporterSchemaConfig } from "../generated/index";
import { queueIssues } from "./common";
import type { Duration, ExporterHelperSettings } from "./common";

// ── otlp ─────────────────────────────────────────────────────────────

export type OtlpExporterConfig = OtlpExporterSchemaConfig;

/** Sends OTLP over gRPC to another collector or a backend. */
export const OtlpExporter = defineBuiltin<OtlpExporterConfig, "exporter", "otlp">({
  kind: "exporter",
  type: "otlp",
  description: "Sends traces, metrics and logs over OTLP gRPC",
  validate: (c) => [...(c.endpoint ? [] : ["endpoint is empty"]), ...queueIssues(c)],
  endpoints: (c) => (c.endpoint ? [c.endpoint] : []),
  protocols: () => ["grpc"],
});

// ── otlphttp ─────────────────────────────────────────────────────────

export type OtlpHttpExporterConfig = OtlpHttpExporterSchemaConfig;

/** Sends OTLP over HTTP. `endpoint` gets `/v1/traces` etc. appended; the per-signal endpoints are used as given. */
export const OtlpHttpExporter = defineBuiltin<OtlpHttpExporterConfig, "exporter", "otlphttp">({
  kind: "exporter",
  type: "otlphttp",
  description: "Sends traces, metrics and logs over OTLP HTTP",
  validate: (c) => [
    ...(c.endpoint || c.traces_endpoint || c.metrics_endpoint || c.logs_endpoint
      ? []
      : ["set endpoint, or at least one of traces_endpoint, metrics_endpoint and logs_endpoint"]),
    ...queueIssues(c),
  ],
  endpoints: (c) =>
    [c.endpoint, c.traces_endpoint, c.metrics_endpoint, c.logs_endpoint].filter((e): e is string => typeof e === "string" && e !== ""),
  protocols: (c) => [c.encoding === "json" ? "http/json" : "http/protobuf"],
});

// ── debug ────────────────────────────────────────────────────────────

export type DebugExporterConfig = DebugExporterSchemaConfig;

/** Writes telemetry to the collector's console, for debugging. */
export const DebugExporter = defineBuiltin<DebugExporterConfig, "exporter", "debug">({
  kind: "exporter",
  type: "debug",
  description: "Writes telemetry to the collector's console, for debugging",
  endpoints: () => ["console"],
});

// ── prometheus ───────────────────────────────────────────────────────

/** The exporter has nothing to serve on without an endpoint. */
export type PrometheusExporterConfig = Require<PrometheusExporterSchemaConfig, "endpoint">;

/** Serves metrics on an endpoint Prometheus scrapes. */
export const PrometheusExporter = defineBuiltin<PrometheusExporterConfig, "exporter", "prometheus">({
  kind: "exporter",
  type: "prometheus",
  description: "Serves metrics on an endpoint for Prometheus to scrape",
  validate: (c) => (c.endpoint ? [] : ["endpoint is empty, so there is nothing to scrape"]),
  endpoints: (c) => (c.endpoint ? [c.endpoint] : []),
});

// ── googlecloud ──────────────────────────────────────────────────────

export interface GoogleCloudResourceFilter {
  prefix?: string;
  regex?: string;
}

/**
 * The exporter embeds `collector.Config` from GoogleCloudPlatform's
 * opentelemetry-operations-go, outside the collector repositories, so the
 * schema carries only the exporterhelper fields. The rest is written here
 * against that module's config.go.
 */
export type GoogleCloudExporterConfig = Overlay<
  GoogleCloudExporterSchemaConfig,
  {
    /** The GCP project. Detected from credentials when omitted. */
    project?: string;
    user_agent?: string;
    destination_project_quota?: boolean;
    metric?: {
      prefix?: string;
      endpoint?: string;
      use_insecure?: boolean;
      known_domains?: string[];
      skip_create_descriptor?: boolean;
      instrumentation_library_labels?: boolean;
      create_service_timeseries?: boolean;
      create_metric_descriptor_buffer_size?: number;
      service_resource_labels?: boolean;
      resource_filters?: GoogleCloudResourceFilter[];
      cumulative_normalization?: boolean;
      sum_of_squared_deviation?: boolean;
    };
    trace?: {
      endpoint?: string;
      use_insecure?: boolean;
      attribute_mappings?: Array<{ key: string; replacement: string }>;
    };
    log?: {
      endpoint?: string;
      use_insecure?: boolean;
      default_log_name?: string;
      resource_filters?: GoogleCloudResourceFilter[];
      service_resource_labels?: boolean;
      error_reporting_type?: boolean;
    };
  }
>;

/**
 * Sends traces to Cloud Trace, metrics to Cloud Monitoring and logs to Cloud
 * Logging. With no endpoint overrides its topology endpoint is
 * `googlecloud://projects/<project>`, naming where the data lands.
 */
export const GoogleCloudExporter = defineBuiltin<GoogleCloudExporterConfig, "exporter", "googlecloud">({
  kind: "exporter",
  type: "googlecloud",
  description: "Sends traces to Cloud Trace, metrics to Cloud Monitoring and logs to Cloud Logging",
  endpoints: (c) => {
    const overrides = [c.trace?.endpoint, c.metric?.endpoint, c.log?.endpoint].filter(
      (e): e is string => typeof e === "string" && e !== "",
    );
    return [`googlecloud://projects/${c.project ?? "(detected)"}`, ...overrides];
  },
});

// ── clickhouse ───────────────────────────────────────────────────────

/** One metric type's table under `metrics_tables`. */
export interface ClickHouseMetricTable {
  name?: string;
}

/**
 * The `clickhouse` exporter's config at contrib v0.130.0
 * (`exporter/clickhouseexporter/config.go`). Stability there: traces and logs
 * beta, metrics alpha.
 */
export interface ClickHouseExporterConfig extends ExporterHelperSettings {
  /** The server, as a DSN URL: `tcp://clickhouse:9000`, `http://clickhouse:8123`, `https://...`. A path names the database. */
  endpoint: string;
  username?: string;
  password?: string;
  /** The database to write to (default `default`). Wins over the endpoint's database unless it is `default`. */
  database?: string;
  /** Extra DSN query parameters, such as `dial_timeout`. */
  connection_params?: Record<string, string>;
  /** Default `otel_logs`. */
  logs_table_name?: string;
  /** Default `otel_traces`. */
  traces_table_name?: string;
  /** @deprecated A prefix for the metric tables, read only when `metrics_tables` names none. Use `metrics_tables`. */
  metrics_table_name?: string;
  /** The table per metric type (defaults `otel_metrics_gauge`, `_sum`, `_summary`, `_histogram`, `_exponential_histogram`). */
  metrics_tables?: {
    gauge?: ClickHouseMetricTable;
    sum?: ClickHouseMetricTable;
    summary?: ClickHouseMetricTable;
    histogram?: ClickHouseMetricTable;
    exponential_histogram?: ClickHouseMetricTable;
  };
  /** How long rows are kept, as a Go duration (`72h`). Used only when the exporter creates the tables. 0 means no TTL. */
  ttl?: Duration;
  /** The engine of the tables the exporter creates (default `MergeTree()`). */
  table_engine?: { name?: string; params?: string };
  /** Adds `ON CLUSTER <name>` to the exporter's create statements. */
  cluster_name?: string;
  /**
   * Run the create statements for the database and tables at start (default
   * true). The exporter's README advises false in production, with the schema
   * managed elsewhere, such as the sql lexicon's `OtelTables`.
   */
  create_schema?: boolean;
  /** `none`, `zstd`, `lz4` (default), `gzip`, `deflate`, `br`, or `true` for lz4. */
  compress?: "none" | "zstd" | "lz4" | "gzip" | "deflate" | "br" | "true";
  /** Async inserts (default true), unless the endpoint or `connection_params` set them. */
  async_insert?: boolean;
}

/**
 * Writes traces, metrics and logs into ClickHouse tables. The tables it writes
 * are the ones `ClickHouseExporterConfig` names; OTEL129 checks them against
 * the tables a sql build in the same root declares.
 */
export const ClickHouseExporter = defineBuiltin<ClickHouseExporterConfig, "exporter", "clickhouse">({
  kind: "exporter",
  type: "clickhouse",
  description: "Writes traces, metrics and logs into ClickHouse tables",
  validate: (c) => {
    const problems: string[] = [];
    if (!c.endpoint) problems.push("endpoint is empty; the exporter requires it");
    else if (!c.endpoint.includes("${")) {
      try {
        new URL(c.endpoint);
      } catch {
        problems.push(`endpoint ${c.endpoint} is not a URL; the exporter parses it as a DSN such as tcp://host:9000`);
      }
    }
    return [...problems, ...queueIssues(c)];
  },
  endpoints: (c) => (c.endpoint ? [c.endpoint] : []),
});
