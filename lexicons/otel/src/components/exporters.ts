/**
 * Built-in exporters: otlp, otlphttp, debug, prometheus, googlecloud.
 */

import { defineBuiltin } from "../define";
import type { Duration, ExporterHelperSettings, GRPCClientSettings, HTTPClientSettings, TLSServerSettings } from "./common";

// ── otlp ─────────────────────────────────────────────────────────────

export type OtlpExporterConfig = GRPCClientSettings & ExporterHelperSettings;

/** Sends OTLP over gRPC to another collector or a backend. */
export const OtlpExporter = defineBuiltin<OtlpExporterConfig, "exporter", "otlp">({
  kind: "exporter",
  type: "otlp",
  description: "Sends traces, metrics and logs over OTLP gRPC",
  validate: (c) => (c.endpoint ? [] : ["endpoint is empty"]),
  endpoints: (c) => (c.endpoint ? [c.endpoint] : []),
});

// ── otlphttp ─────────────────────────────────────────────────────────

export type OtlpHttpExporterConfig = HTTPClientSettings &
  ExporterHelperSettings & {
    traces_endpoint?: string;
    metrics_endpoint?: string;
    logs_endpoint?: string;
    encoding?: "proto" | "json";
  };

/** Sends OTLP over HTTP. `endpoint` gets `/v1/traces` etc. appended; the per-signal endpoints are used as given. */
export const OtlpHttpExporter = defineBuiltin<OtlpHttpExporterConfig, "exporter", "otlphttp">({
  kind: "exporter",
  type: "otlphttp",
  description: "Sends traces, metrics and logs over OTLP HTTP",
  validate: (c) =>
    c.endpoint || c.traces_endpoint || c.metrics_endpoint || c.logs_endpoint
      ? []
      : ["set endpoint, or at least one of traces_endpoint, metrics_endpoint and logs_endpoint"],
  endpoints: (c) =>
    [c.endpoint, c.traces_endpoint, c.metrics_endpoint, c.logs_endpoint].filter((e): e is string => typeof e === "string" && e !== ""),
});

// ── debug ────────────────────────────────────────────────────────────

export interface DebugExporterConfig {
  verbosity?: "basic" | "normal" | "detailed";
  sampling_initial?: number;
  sampling_thereafter?: number;
  use_internal_logger?: boolean;
}

/** Writes telemetry to the collector's console, for debugging. */
export const DebugExporter = defineBuiltin<DebugExporterConfig, "exporter", "debug">({
  kind: "exporter",
  type: "debug",
  description: "Writes telemetry to the collector's console, for debugging",
  endpoints: () => ["console"],
});

// ── prometheus ───────────────────────────────────────────────────────

export interface PrometheusExporterConfig {
  /** The address the exporter serves `/metrics` on, e.g. `0.0.0.0:8889`. */
  endpoint: string;
  namespace?: string;
  const_labels?: Record<string, string>;
  send_timestamps?: boolean;
  metric_expiration?: Duration;
  enable_open_metrics?: boolean;
  add_metric_suffixes?: boolean;
  resource_to_telemetry_conversion?: { enabled: boolean };
  tls?: TLSServerSettings;
}

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

export interface GoogleCloudExporterConfig extends ExporterHelperSettings {
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
