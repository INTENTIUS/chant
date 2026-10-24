/**
 * Built-in processors: batch, memory_limiter, resource, attributes,
 * k8sattributes, resourcedetection, deltatocumulative.
 */

import { defineBuiltin } from "../define";
import type { Require } from "./overlay";
import type { AttributesProcessorSchemaConfig, BatchProcessorSchemaConfig, DeltaToCumulativeProcessorSchemaConfig, K8sAttributesProcessorSchemaConfig, MemoryLimiterProcessorSchemaConfig, ResourceDetectionProcessorSchemaConfig, ResourceProcessorSchemaConfig } from "../generated/index";
import { goDurationMs } from "./common";

/** One entry of `actions` (attributes) or `attributes` (resource), as upstream's `attraction.ActionKeyValue` types it. */
export type AttributeActionConfig = NonNullable<AttributesProcessorSchemaConfig["actions"]>[number];

// ── batch ────────────────────────────────────────────────────────────

export type BatchProcessorConfig = BatchProcessorSchemaConfig;

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

/** With no `check_interval` the limiter never measures, so chant asks for it. */
export type MemoryLimiterProcessorConfig = Require<MemoryLimiterProcessorSchemaConfig, "check_interval">;

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

/** The processor refuses to start with no actions. */
export type ResourceProcessorConfig = Require<ResourceProcessorSchemaConfig, "attributes">;

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

/** The processor refuses to start with no actions. */
export type AttributesProcessorConfig = Require<AttributesProcessorSchemaConfig, "actions">;

/** Inserts, updates, hashes or deletes span, log and metric attributes. */
export const AttributesProcessor = defineBuiltin<AttributesProcessorConfig, "processor", "attributes">({
  kind: "processor",
  type: "attributes",
  description: "Inserts, updates, hashes or deletes span, log and metric attributes",
  validate: (c) => actionProblems(c.actions, "actions"),
});

function actionProblems(actions: ReadonlyArray<AttributeActionConfig> | undefined, field: string): string[] {
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

export type K8sAttributesProcessorConfig = K8sAttributesProcessorSchemaConfig;

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

/** With no detectors the processor detects nothing, so chant asks for the list. */
export type ResourceDetectionProcessorConfig = Require<ResourceDetectionProcessorSchemaConfig, "detectors">;

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

export type DeltaToCumulativeProcessorConfig = DeltaToCumulativeProcessorSchemaConfig;

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
