/**
 * Built-in receivers: otlp, prometheus, hostmetrics, filelog.
 */

import { defineBuiltin } from "../define";
import type { Duration, GRPCServerSettings, HTTPServerSettings, TLSClientSettings } from "./common";

// ── otlp ─────────────────────────────────────────────────────────────

export interface OtlpReceiverConfig {
  protocols?: {
    grpc?: GRPCServerSettings | null;
    http?:
      | (HTTPServerSettings & {
          traces_url_path?: string;
          metrics_url_path?: string;
          logs_url_path?: string;
        })
      | null;
  };
}

/** Receives OTLP over gRPC (default port 4317) and HTTP (default port 4318). */
export const OtlpReceiver = defineBuiltin<OtlpReceiverConfig, "receiver", "otlp">({
  kind: "receiver",
  type: "otlp",
  description: "Receives traces, metrics and logs over OTLP gRPC (4317) and HTTP (4318)",
  validate: (c) =>
    !c.protocols || (!("grpc" in c.protocols) && !("http" in c.protocols))
      ? ["protocols enables neither grpc nor http, so the receiver listens on nothing"]
      : [],
  endpoints: (c) => {
    const out: string[] = [];
    if (c.protocols && "grpc" in c.protocols) out.push(c.protocols.grpc?.endpoint ?? "localhost:4317");
    if (c.protocols && "http" in c.protocols) out.push(c.protocols.http?.endpoint ?? "localhost:4318");
    return out;
  },
  // The HTTP receiver takes protobuf and JSON bodies on the same port.
  protocols: (c) => [
    ...(c.protocols && "grpc" in c.protocols ? ["grpc"] : []),
    ...(c.protocols && "http" in c.protocols ? ["http/protobuf", "http/json"] : []),
  ],
});

// ── prometheus ───────────────────────────────────────────────────────

export interface PrometheusStaticConfig {
  targets: string[];
  labels?: Record<string, string>;
}

/** Prometheus's `tls_config` (prometheus/common `TLSConfig`). Versions are spelled `TLS12`, `TLS13`. */
export interface PrometheusTLSConfig {
  ca?: string;
  cert?: string;
  key?: string;
  ca_file?: string;
  cert_file?: string;
  key_file?: string;
  ca_ref?: string;
  cert_ref?: string;
  key_ref?: string;
  server_name?: string;
  insecure_skip_verify?: boolean;
  min_version?: string;
  max_version?: string;
}

/** Prometheus's proxy settings, inlined into the HTTP client and OAuth2 blocks. */
export interface PrometheusProxySettings {
  proxy_url?: string;
  no_proxy?: string;
  proxy_from_environment?: boolean;
  proxy_connect_header?: Record<string, string[]>;
}

/** Scrape authentication with a user name and password. Prefer `password_file` or `${env:...}` to a literal password. */
export interface PrometheusBasicAuth {
  username?: string;
  username_file?: string;
  username_ref?: string;
  password?: string;
  password_file?: string;
  password_ref?: string;
}

/** An `Authorization` header: `type` defaults to `Bearer`. */
export interface PrometheusAuthorization {
  type?: string;
  credentials?: string;
  credentials_file?: string;
  credentials_ref?: string;
}

export interface PrometheusOAuth2 extends PrometheusProxySettings {
  client_id: string;
  client_secret?: string;
  client_secret_file?: string;
  client_secret_ref?: string;
  scopes?: string[];
  token_url: string;
  endpoint_params?: Record<string, string>;
  tls_config?: PrometheusTLSConfig;
}

/**
 * One Prometheus scrape job, as the Prometheus release collector-contrib
 * v0.130.0 embeds reads it (scrape settings plus prometheus/common's HTTP
 * client settings). Service-discovery (`*_sd_configs`) and relabel blocks
 * pass through as written.
 */
export interface PrometheusScrapeConfig extends PrometheusProxySettings {
  job_name: string;
  scrape_interval?: Duration;
  scrape_timeout?: Duration;
  scrape_protocols?: string[];
  fallback_scrape_protocol?: string;
  always_scrape_classic_histograms?: boolean;
  convert_classic_histograms_to_nhcb?: boolean;
  scrape_failure_log_file?: string;
  metrics_path?: string;
  scheme?: "http" | "https";
  honor_labels?: boolean;
  honor_timestamps?: boolean;
  track_timestamps_staleness?: boolean;
  enable_compression?: boolean;
  params?: Record<string, string[]>;
  static_configs?: PrometheusStaticConfig[];
  kubernetes_sd_configs?: Array<Record<string, unknown>>;
  file_sd_configs?: Array<Record<string, unknown>>;
  /** Any other service-discovery block (`dns_sd_configs`, `ec2_sd_configs`, `consul_sd_configs`, ...). */
  [sd: `${string}_sd_configs`]: Array<Record<string, unknown>> | undefined;
  relabel_configs?: Array<Record<string, unknown>>;
  metric_relabel_configs?: Array<Record<string, unknown>>;
  basic_auth?: PrometheusBasicAuth;
  authorization?: PrometheusAuthorization;
  oauth2?: PrometheusOAuth2;
  bearer_token?: string;
  bearer_token_file?: string;
  tls_config?: PrometheusTLSConfig;
  follow_redirects?: boolean;
  enable_http2?: boolean;
  http_headers?: Record<string, { values?: string[]; secrets?: string[]; files?: string[] }>;
  body_size_limit?: string;
  sample_limit?: number;
  target_limit?: number;
  label_limit?: number;
  label_name_length_limit?: number;
  label_value_length_limit?: number;
  native_histogram_bucket_limit?: number;
  native_histogram_min_bucket_factor?: number;
  keep_dropped_targets?: number;
  metric_name_validation_scheme?: "utf8" | "legacy";
  metric_name_escaping_scheme?: "allow-utf-8" | "underscores" | "dots" | "values";
}

export interface PrometheusReceiverConfig {
  config: {
    global?: { scrape_interval?: Duration; scrape_timeout?: Duration; evaluation_interval?: Duration; external_labels?: Record<string, string> };
    scrape_configs: PrometheusScrapeConfig[];
  };
  trim_metric_suffixes?: boolean;
  use_start_time_metric?: boolean;
  start_time_metric_regex?: string;
  target_allocator?: {
    endpoint: string;
    interval?: Duration;
    collector_id?: string;
    tls?: TLSClientSettings;
  };
}

/** Scrapes Prometheus endpoints with Prometheus's own scrape config. */
export const PrometheusReceiver = defineBuiltin<PrometheusReceiverConfig, "receiver", "prometheus">({
  kind: "receiver",
  type: "prometheus",
  description: "Scrapes Prometheus endpoints using Prometheus scrape_configs",
  validate: (c) => {
    const problems: string[] = [];
    const seen = new Set<string>();
    for (const job of c.config?.scrape_configs ?? []) {
      if (seen.has(job.job_name)) problems.push(`scrape job "${job.job_name}" is declared twice`);
      seen.add(job.job_name);
    }
    if ((c.config?.scrape_configs ?? []).length === 0 && !c.target_allocator) {
      problems.push("config.scrape_configs is empty and no target_allocator is set, so nothing is scraped");
    }
    return problems;
  },
  endpoints: (c) =>
    (c.config?.scrape_configs ?? []).flatMap((job) => (job.static_configs ?? []).flatMap((s) => s.targets)),
});

// ── hostmetrics ──────────────────────────────────────────────────────

export type HostMetricsScraper =
  | "cpu"
  | "disk"
  | "load"
  | "filesystem"
  | "memory"
  | "network"
  | "paging"
  | "processes"
  | "process"
  | "system";

export interface HostMetricsReceiverConfig {
  collection_interval?: Duration;
  initial_delay?: Duration;
  /** Host root when the collector runs in a container, e.g. `/hostfs`. */
  root_path?: string;
  /** Scraper name to its settings; `{}` enables a scraper with its defaults. */
  scrapers: Partial<Record<HostMetricsScraper, Record<string, unknown>>>;
}

/** Scrapes CPU, memory, disk, filesystem, network and process metrics from the host. */
export const HostMetricsReceiver = defineBuiltin<HostMetricsReceiverConfig, "receiver", "hostmetrics">({
  kind: "receiver",
  type: "hostmetrics",
  description: "Scrapes host metrics (cpu, memory, disk, filesystem, network, processes)",
  validate: (c) => (Object.keys(c.scrapers ?? {}).length === 0 ? ["scrapers is empty, so no host metric is collected"] : []),
});

// ── filelog ──────────────────────────────────────────────────────────

/** A stanza operator (`regex_parser`, `json_parser`, `move`, …). Its other keys depend on `type`. */
export interface FileLogOperator {
  type: string;
  id?: string;
  output?: string | string[];
  [key: string]: unknown;
}

export interface FileLogReceiverConfig {
  include: string[];
  exclude?: string[];
  start_at?: "beginning" | "end";
  include_file_name?: boolean;
  include_file_path?: boolean;
  include_file_name_resolved?: boolean;
  include_file_path_resolved?: boolean;
  poll_interval?: Duration;
  max_concurrent_files?: number;
  max_log_size?: string;
  fingerprint_size?: string;
  encoding?: string;
  force_flush_period?: Duration;
  delete_after_read?: boolean;
  /** The id of a storage extension, so offsets survive a restart. */
  storage?: string;
  multiline?: { line_start_pattern?: string; line_end_pattern?: string; omit_pattern?: boolean };
  operators?: FileLogOperator[];
  attributes?: Record<string, string>;
  resource?: Record<string, string>;
  retry_on_failure?: { enabled?: boolean; initial_interval?: Duration; max_interval?: Duration; max_elapsed_time?: Duration };
}

/** Tails log files and parses them with stanza operators. */
export const FileLogReceiver = defineBuiltin<FileLogReceiverConfig, "receiver", "filelog">({
  kind: "receiver",
  type: "filelog",
  description: "Tails log files and parses each line with stanza operators",
  validate: (c) => (c.include?.length ? [] : ["include is empty, so no file is read"]),
  endpoints: (c) => c.include ?? [],
});
