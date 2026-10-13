/**
 * The plain-data model of `prometheus.yml`: global settings, scrape configs,
 * relabelling, service discovery, Alertmanager targets and remote storage.
 *
 * Written by hand against Prometheus v3.15.0 (`config/config.go` and
 * `discovery/*`), field names in the file's own snake_case. SchemaStore's
 * `prometheus.json` is not used to generate these: it is strict about unknown
 * keys and behind v3.15.0 (no `runtime`, `otlp` or `tracing`, 11 of about 20
 * `global` keys, 24 of 32 discovery kinds), so types generated from it would
 * reject configs Prometheus accepts.
 *
 * Six discovery kinds are typed: kubernetes, file, http, dns, ec2 and consul.
 * Any other `<kind>_sd_configs` key is carried as untyped data.
 */

import type { HttpClientConfig } from "./integrations";
import type { LabelSet } from "./model";

/** One `static_configs` entry: fixed targets and the labels they share. */
export interface StaticConfig {
  /** `host:port` addresses to scrape (or, under `alerting`, to send alerts to). */
  targets: string[];
  labels?: LabelSet;
}

/** The actions a relabel step can take. */
export type RelabelAction =
  | "replace"
  | "lowercase"
  | "uppercase"
  | "keep"
  | "drop"
  | "keepequal"
  | "dropequal"
  | "hashmod"
  | "labelmap"
  | "labeldrop"
  | "labelkeep";

/** One `relabel_configs` / `metric_relabel_configs` / `write_relabel_configs` step. */
export interface RelabelConfig {
  /** Labels whose values are joined with `separator` and matched against `regex`. */
  source_labels?: string[];
  /** Defaults to `;`. */
  separator?: string;
  target_label?: string;
  /** An RE2 regex, anchored. Defaults to `(.*)`. */
  regex?: string;
  modulus?: number;
  /** Defaults to `$1`. */
  replacement?: string;
  /** Defaults to `replace`. */
  action?: RelabelAction;
}

// ── Service discovery ───────────────────────────────────────────────

/** `kubernetes_sd_configs` entry. */
export interface KubernetesSDConfig extends HttpClientConfig {
  role: "pod" | "service" | "endpoints" | "endpointslice" | "node" | "ingress";
  kubeconfig_file?: string;
  api_server?: string;
  namespaces?: { own_namespace?: boolean; names?: string[] };
  selectors?: Array<{ role: string; label?: string; field?: string }>;
  attach_metadata?: { node?: boolean; namespace?: boolean };
}

/** `file_sd_configs` entry: target files Prometheus re-reads. */
export interface FileSDConfig {
  /** Paths or globs of YAML and JSON target files. */
  files: string[];
  refresh_interval?: string;
}

/** `http_sd_configs` entry: targets fetched from a URL. */
export interface HttpSDConfig extends HttpClientConfig {
  url: string;
  refresh_interval?: string;
}

/** `dns_sd_configs` entry. */
export interface DnsSDConfig {
  names: string[];
  /** `SRV` (default), `A`, `AAAA`, `MX` or `NS`. */
  type?: "SRV" | "A" | "AAAA" | "MX" | "NS";
  /** Required for every type but `SRV`. */
  port?: number;
  refresh_interval?: string;
}

/** `ec2_sd_configs` entry. */
export interface Ec2SDConfig extends HttpClientConfig {
  region?: string;
  endpoint?: string;
  /** A credential: prefer the environment or an instance role. */
  access_key?: string;
  secret_key?: string;
  profile?: string;
  role_arn?: string;
  refresh_interval?: string;
  port?: number;
  filters?: Array<{ name: string; values: string[] }>;
}

/** `consul_sd_configs` entry. */
export interface ConsulSDConfig extends HttpClientConfig {
  server?: string;
  /** A credential. */
  token?: string;
  datacenter?: string;
  namespace?: string;
  partition?: string;
  scheme?: "http" | "https";
  username?: string;
  password?: string;
  allow_stale?: boolean;
  services?: string[];
  tags?: string[];
  tag_separator?: string;
  node_meta?: Record<string, string>;
  refresh_interval?: string;
  filter?: string;
}

/** The service discovery lists of a scrape config or an Alertmanager target group. */
export interface ServiceDiscoveryConfigs {
  kubernetes_sd_configs?: KubernetesSDConfig[];
  file_sd_configs?: FileSDConfig[];
  http_sd_configs?: HttpSDConfig[];
  dns_sd_configs?: DnsSDConfig[];
  ec2_sd_configs?: Ec2SDConfig[];
  consul_sd_configs?: ConsulSDConfig[];
  /** Any other discovery kind (`azure_sd_configs`, `gce_sd_configs`, ...), carried as written. */
  [other: `${string}_sd_configs`]: unknown[] | undefined;
}

/** The discovery kinds typed above. */
export const TYPED_SD_KINDS = Object.freeze([
  "kubernetes_sd_configs",
  "file_sd_configs",
  "http_sd_configs",
  "dns_sd_configs",
  "ec2_sd_configs",
  "consul_sd_configs",
]);

// ── Scrape configs ──────────────────────────────────────────────────

/** Limits and histogram settings that exist both in `global` and per scrape config. */
export interface ScrapeDefaults {
  scrape_interval?: string;
  scrape_timeout?: string;
  /** e.g. `PrometheusProto`, `OpenMetricsText1.0.0`, `PrometheusText0.0.4`. */
  scrape_protocols?: string[];
  body_size_limit?: string;
  sample_limit?: number;
  label_limit?: number;
  label_name_length_limit?: number;
  label_value_length_limit?: number;
  target_limit?: number;
  keep_dropped_targets?: number;
  always_scrape_classic_histograms?: boolean;
  convert_classic_histograms_to_nhcb?: boolean;
  metric_name_validation_scheme?: "utf8" | "legacy";
  metric_name_escaping_scheme?: "allow-utf-8" | "underscores" | "dots" | "values";
  native_histogram_bucket_limit?: number;
  native_histogram_min_bucket_factor?: number;
}

/** One scrape job. */
export interface ScrapeJobConfig extends ScrapeDefaults, HttpClientConfig, ServiceDiscoveryConfigs {
  /** Unique across the file; the `job` label on every target. */
  job_name: string;
  honor_labels?: boolean;
  honor_timestamps?: boolean;
  track_timestamps_staleness?: boolean;
  fallback_scrape_protocol?: string;
  /** Defaults to `/metrics`. */
  metrics_path?: string;
  /** `http` (default) or `https`. */
  scheme?: "http" | "https";
  /** URL query parameters sent with every scrape. */
  params?: Record<string, string[]>;
  enable_compression?: boolean;
  static_configs?: StaticConfig[];
  relabel_configs?: RelabelConfig[];
  metric_relabel_configs?: RelabelConfig[];
}

// ── Top-level sections ──────────────────────────────────────────────

/** `global:`. */
export interface PrometheusGlobalConfig extends ScrapeDefaults {
  evaluation_interval?: string;
  rule_query_offset?: string;
  /** Labels added to every series sent to remote storage and every alert. */
  external_labels?: LabelSet;
  query_log_file?: string;
  scrape_failure_log_file?: string;
}

/** One `alerting.alertmanagers` entry. */
export interface AlertmanagerTarget extends HttpClientConfig, ServiceDiscoveryConfigs {
  timeout?: string;
  api_version?: "v2";
  path_prefix?: string;
  scheme?: "http" | "https";
  relabel_configs?: RelabelConfig[];
  alert_relabel_configs?: RelabelConfig[];
  static_configs?: StaticConfig[];
}

/** `alerting:`. */
export interface PrometheusAlertingConfig {
  alert_relabel_configs?: RelabelConfig[];
  alertmanagers?: AlertmanagerTarget[];
}

/** `remote_write[].queue_config`. */
export interface QueueConfig {
  capacity?: number;
  max_shards?: number;
  min_shards?: number;
  max_samples_per_send?: number;
  batch_send_deadline?: string;
  min_backoff?: string;
  max_backoff?: string;
  retry_on_http_429?: boolean;
  sample_age_limit?: string;
}

/** One `remote_write` entry. */
export interface RemoteWriteConfig extends HttpClientConfig {
  url: string;
  name?: string;
  remote_timeout?: string;
  headers?: Record<string, string>;
  write_relabel_configs?: RelabelConfig[];
  send_exemplars?: boolean;
  send_native_histograms?: boolean;
  queue_config?: QueueConfig;
  metadata_config?: { send?: boolean; send_interval?: string; max_samples_per_send?: number };
  sigv4?: {
    region?: string;
    access_key?: string;
    secret_key?: string;
    profile?: string;
    role_arn?: string;
  };
  azuread?: Record<string, unknown>;
  google_iam?: Record<string, unknown>;
}

/** One `remote_read` entry. */
export interface RemoteReadConfig extends HttpClientConfig {
  url: string;
  name?: string;
  remote_timeout?: string;
  headers?: Record<string, string>;
  read_recent?: boolean;
  required_matchers?: LabelSet;
  filter_external_labels?: boolean;
}

/** `otlp:`: how OTLP metrics pushed to Prometheus become series. */
export interface OtlpConfig {
  promote_all_resource_attributes?: boolean;
  promote_resource_attributes?: string[];
  ignore_resource_attributes?: string[];
  translation_strategy?: "UnderscoreEscapingWithSuffixes" | "UnderscoreEscapingWithoutSuffixes" | "NoUTF8EscapingWithSuffixes" | "NoTranslation";
  keep_identifying_resource_attributes?: boolean;
  convert_histograms_to_nhcb?: boolean;
}

/** The sections of a `prometheus.yml` besides its scrape jobs. */
export interface PrometheusConfigSections {
  global?: PrometheusGlobalConfig;
  alerting?: PrometheusAlertingConfig;
  /** Paths or globs of rule files, relative to the config file. */
  rule_files?: string[];
  /** Paths or globs of files holding more `scrape_configs`. */
  scrape_config_files?: string[];
  remote_write?: RemoteWriteConfig[];
  remote_read?: RemoteReadConfig[];
  otlp?: OtlpConfig;
  /** TSDB and exemplar settings, carried as written. */
  storage?: Record<string, unknown>;
  /** Where Prometheus sends its own traces, carried as written. */
  tracing?: Record<string, unknown>;
  /** Go runtime settings (`gogc`), carried as written. */
  runtime?: Record<string, unknown>;
}

/** A whole `prometheus.yml`. */
export interface PrometheusConfigFile extends PrometheusConfigSections {
  scrape_configs?: ScrapeJobConfig[];
}

/** Top-level keys of `prometheus.yml`, in the order Prometheus documents them. */
export const PROMETHEUS_CONFIG_SECTIONS = Object.freeze([
  "global",
  "alerting",
  "rule_files",
  "scrape_config_files",
  "scrape_configs",
  "remote_write",
  "remote_read",
  "otlp",
  "storage",
  "tracing",
  "runtime",
]);

const GLOBAL_ONLY_KEYS = ["scrape_interval", "scrape_timeout", "evaluation_interval", "external_labels", "rule_query_offset", "query_log_file"];

/** True when a parsed document has the shape of a `prometheus.yml`. */
export function looksLikePrometheusConfig(value: unknown): value is PrometheusConfigFile {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  if ("apiVersion" in v || "kind" in v || "groups" in v || "route" in v || "receivers" in v) return false;
  if (PROMETHEUS_CONFIG_SECTIONS.some((k) => k !== "global" && k !== "runtime" && k !== "storage" && k !== "tracing" && k in v)) {
    return true;
  }
  // `global:` alone is Alertmanager's too; only Prometheus's own keys settle it.
  const g = v.global;
  return typeof g === "object" && g !== null && GLOBAL_ONLY_KEYS.some((k) => k in g);
}
