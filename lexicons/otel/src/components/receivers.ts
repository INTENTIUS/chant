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
});

// ── prometheus ───────────────────────────────────────────────────────

export interface PrometheusStaticConfig {
  targets: string[];
  labels?: Record<string, string>;
}

/** One Prometheus scrape job. Service-discovery and relabel blocks pass through as written. */
export interface PrometheusScrapeConfig {
  job_name: string;
  scrape_interval?: Duration;
  scrape_timeout?: Duration;
  metrics_path?: string;
  scheme?: "http" | "https";
  honor_labels?: boolean;
  honor_timestamps?: boolean;
  params?: Record<string, string[]>;
  static_configs?: PrometheusStaticConfig[];
  kubernetes_sd_configs?: Array<Record<string, unknown>>;
  file_sd_configs?: Array<Record<string, unknown>>;
  relabel_configs?: Array<Record<string, unknown>>;
  metric_relabel_configs?: Array<Record<string, unknown>>;
  tls_config?: Record<string, unknown>;
  authorization?: { type?: string; credentials_file?: string };
  bearer_token_file?: string;
  sample_limit?: number;
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
