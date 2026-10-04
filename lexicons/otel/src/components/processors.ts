/**
 * Built-in processors: batch, memory_limiter, resource, attributes,
 * k8sattributes, resourcedetection, deltatocumulative.
 */

import { defineBuiltin } from "../define";
import { goDurationMs, type AttributeAction, type Duration } from "./common";

// ── batch ────────────────────────────────────────────────────────────

export interface BatchProcessorConfig {
  timeout?: Duration;
  send_batch_size?: number;
  send_batch_max_size?: number;
  metadata_keys?: string[];
  metadata_cardinality_limit?: number;
}

/** Batches telemetry before export, to cut request count and compress better. */
export const BatchProcessor = defineBuiltin<BatchProcessorConfig, "processor", "batch">({
  kind: "processor",
  type: "batch",
  description: "Groups telemetry into batches before export",
  validate: (c) =>
    c.send_batch_max_size !== undefined && c.send_batch_max_size !== 0 && c.send_batch_size !== undefined && c.send_batch_max_size < c.send_batch_size
      ? [`send_batch_max_size (${c.send_batch_max_size}) is below send_batch_size (${c.send_batch_size}); the collector rejects this`]
      : [],
});

// ── memory_limiter ───────────────────────────────────────────────────

export interface MemoryLimiterProcessorConfig {
  check_interval: Duration;
  limit_mib?: number;
  spike_limit_mib?: number;
  limit_percentage?: number;
  spike_limit_percentage?: number;
}

/** Refuses data when the collector nears its memory limit. Belongs first in every pipeline. */
export const MemoryLimiterProcessor = defineBuiltin<MemoryLimiterProcessorConfig, "processor", "memory_limiter">({
  kind: "processor",
  type: "memory_limiter",
  description: "Refuses data when the collector nears a memory limit; runs first in a pipeline",
  validate: (c) => {
    const problems: string[] = [];
    if (c.limit_mib === undefined && c.limit_percentage === undefined) {
      problems.push("set limit_mib or limit_percentage; with neither the collector refuses to start");
    }
    if (c.limit_mib !== undefined && c.spike_limit_mib !== undefined && c.spike_limit_mib >= c.limit_mib) {
      problems.push(`spike_limit_mib (${c.spike_limit_mib}) must be below limit_mib (${c.limit_mib})`);
    }
    if (c.limit_percentage !== undefined && (c.limit_percentage <= 0 || c.limit_percentage > 100)) {
      problems.push(`limit_percentage (${c.limit_percentage}) must be between 1 and 100`);
    }
    return problems;
  },
});

// ── resource ─────────────────────────────────────────────────────────

export interface ResourceProcessorConfig {
  attributes: AttributeAction[];
}

/** Inserts, updates or deletes resource attributes. */
export const ResourceProcessor = defineBuiltin<ResourceProcessorConfig, "processor", "resource">({
  kind: "processor",
  type: "resource",
  description: "Inserts, updates or deletes resource attributes",
  validate: (c) => actionProblems(c.attributes, "attributes"),
});

// ── attributes ───────────────────────────────────────────────────────

/** An include/exclude block of the attributes processor and the filter processor's legacy `spans` (`filterconfig.MatchProperties`). */
export interface AttributesMatch {
  match_type: "strict" | "regexp";
  regexp?: { cacheenabled?: boolean; cachemaxnumentries?: number };
  services?: string[];
  span_names?: string[];
  span_kinds?: string[];
  log_bodies?: string[];
  log_severity_texts?: string[];
  log_severity_number?: { min: number | string; match_undefined?: boolean };
  metric_names?: string[];
  attributes?: Array<{ key: string; value?: unknown }>;
  resources?: Array<{ key: string; value?: unknown }>;
  libraries?: Array<{ name: string; version?: string }>;
}

export interface AttributesProcessorConfig {
  actions: AttributeAction[];
  include?: AttributesMatch;
  exclude?: AttributesMatch;
}

/** Inserts, updates, hashes or deletes span, log and metric attributes. */
export const AttributesProcessor = defineBuiltin<AttributesProcessorConfig, "processor", "attributes">({
  kind: "processor",
  type: "attributes",
  description: "Inserts, updates, hashes or deletes span, log and metric attributes",
  validate: (c) => actionProblems(c.actions, "actions"),
});

function actionProblems(actions: AttributeAction[] | undefined, field: string): string[] {
  if (!actions || actions.length === 0) return [`${field} is empty, so the processor changes nothing`];
  const problems: string[] = [];
  actions.forEach((a, i) => {
    if (a.action !== "extract" && !a.key) problems.push(`${field}[${i}] (${a.action}) needs a key`);
    if (a.action === "extract" && !a.pattern) problems.push(`${field}[${i}] (extract) needs a pattern`);
    if (
      (a.action === "insert" || a.action === "update" || a.action === "upsert") &&
      a.value === undefined &&
      a.from_attribute === undefined &&
      a.from_context === undefined
    ) {
      problems.push(`${field}[${i}] (${a.action}) needs value, from_attribute or from_context`);
    }
    if (a.action === "convert" && !a.converted_type) problems.push(`${field}[${i}] (convert) needs converted_type`);
  });
  return problems;
}

// ── k8sattributes ────────────────────────────────────────────────────

export interface K8sFieldExtract {
  tag_name?: string;
  key?: string;
  key_regex?: string;
  from: "pod" | "namespace" | "node";
}

export interface K8sPodAssociationSource {
  from: "resource_attribute" | "connection";
  name?: string;
}

export interface K8sAttributesProcessorConfig {
  auth_type?: "none" | "serviceAccount" | "kubeConfig" | "tls";
  passthrough?: boolean;
  filter?: {
    node?: string;
    node_from_env_var?: string;
    namespace?: string;
    fields?: Array<{ key: string; value: string; op?: "equals" | "not-equals" }>;
    labels?: Array<{ key: string; value: string; op?: "equals" | "not-equals" | "exists" | "does-not-exist" }>;
  };
  extract?: {
    metadata?: string[];
    labels?: K8sFieldExtract[];
    annotations?: K8sFieldExtract[];
    otel_annotations?: boolean;
  };
  pod_association?: Array<{ sources: K8sPodAssociationSource[] }>;
  exclude?: { pods?: Array<{ name: string }> };
  wait_for_metadata?: boolean;
  wait_for_metadata_timeout?: Duration;
}

/** Adds Kubernetes pod, namespace and node metadata to telemetry. */
export const K8sAttributesProcessor = defineBuiltin<K8sAttributesProcessorConfig, "processor", "k8sattributes">({
  kind: "processor",
  type: "k8sattributes",
  description: "Adds Kubernetes pod, namespace and node metadata to telemetry",
});

// ── resourcedetection ────────────────────────────────────────────────

export type ResourceDetector =
  | "env"
  | "system"
  | "docker"
  | "gcp"
  | "ec2"
  | "ecs"
  | "eks"
  | "elastic_beanstalk"
  | "lambda"
  | "azure"
  | "aks"
  | "consul"
  | "heroku"
  | "openshift"
  | "k8snode"
  | "kubeadm"
  | "dynatrace";

export interface ResourceDetectionProcessorConfig {
  detectors: Array<ResourceDetector | (string & {})>;
  timeout?: Duration;
  override?: boolean;
  /** Per-detector settings, e.g. `system: { hostname_sources: ["os"] }`. */
  system?: Record<string, unknown>;
  ec2?: Record<string, unknown>;
  gcp?: Record<string, unknown>;
  azure?: Record<string, unknown>;
  k8snode?: Record<string, unknown>;
  docker?: Record<string, unknown>;
}

/** Detects the host's resource attributes (cloud, container, host) and adds them. */
export const ResourceDetectionProcessor = defineBuiltin<
  ResourceDetectionProcessorConfig,
  "processor",
  "resourcedetection"
>({
  kind: "processor",
  type: "resourcedetection",
  description: "Detects cloud, container and host resource attributes",
  validate: (c) => (c.detectors?.length ? [] : ["detectors is empty, so nothing is detected"]),
});

// ── deltatocumulative ────────────────────────────────────────────────
//
// Typed against processor/deltatocumulativeprocessor at COLLECTOR_PIN
// (collector-contrib v0.130.0): config.go, factory.go and README.md at that tag,
// https://github.com/open-telemetry/opentelemetry-collector-contrib/tree/v0.130.0/processor/deltatocumulativeprocessor
// Upstream marks it alpha for metrics. It ships in the otelcol-contrib and
// otelcol-k8s distributions at v0.130.0, and keeps every stream's running
// total in memory, so one collector instance must see all of a stream's
// deltas for its totals to be right.

export interface DeltaToCumulativeProcessorConfig {
  /** How long a stream that receives no samples is kept before it is dropped. Positive. Default `5m`. */
  max_stale?: Duration;
  /** The most streams tracked at once; samples of new streams past it are dropped. Not negative. Default unlimited. */
  max_streams?: number;
}

/**
 * Turns delta metrics into cumulative ones by keeping a running total per
 * stream. Exporters that read only cumulative data, such as
 * `prometheusremotewrite`, need it after connectors that emit deltas (`sum`,
 * `count`, `signaltometrics`). Cumulative metrics pass through unchanged.
 */
export const DeltaToCumulativeProcessor = defineBuiltin<DeltaToCumulativeProcessorConfig, "processor", "deltatocumulative">({
  kind: "processor",
  type: "deltatocumulative",
  description: "Converts delta metrics to cumulative by keeping a running total per stream",
  validate: (c) => {
    // config.go Validate.
    const problems: string[] = [];
    const stale = goDurationMs(c.max_stale, 5 * 60_000);
    if (stale !== undefined && stale <= 0) problems.push(`max_stale must be a positive duration (got ${JSON.stringify(c.max_stale)})`);
    if (c.max_streams !== undefined && (!Number.isInteger(c.max_streams) || c.max_streams < 0)) {
      problems.push(`max_streams must be a whole number, 0 or more (got ${c.max_streams})`);
    }
    return problems;
  },
});
