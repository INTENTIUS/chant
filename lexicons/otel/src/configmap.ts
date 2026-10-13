/**
 * Collector configs held in Kubernetes ConfigMaps (chant #2930).
 *
 * `OtelCollector`, `OtelCollectorGateway`, `GkeOtelCollector` and most
 * hand-written manifests carry the collector config as a YAML string under a
 * ConfigMap data key, usually `config.yaml`. The otel config checks
 * (OTEL101-OTEL106, OTEL112) and the k8s placement checks (WK8601-WK8603)
 * both read configs from there, through these two functions.
 *
 * Values are parsed with js-yaml rather than core's YAML reader, which keeps
 * flow lists (`[otlp, batch]`) as strings (chant #2925, #3006).
 */

import { load } from "js-yaml";
import type { CollectorConfig } from "./model";

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Parse a ConfigMap value as a collector config: YAML with a
 * `service.pipelines` map. Undefined for anything else.
 */
export function parseCollectorConfig(text: unknown): CollectorConfig | undefined {
  if (typeof text !== "string") return undefined;
  let value: unknown;
  try {
    value = load(text);
  } catch {
    return undefined;
  }
  if (!isRecord(value) || !isRecord(value.service) || !isRecord(value.service.pipelines)) return undefined;
  return value as unknown as CollectorConfig;
}

/** One collector config found in a ConfigMap. */
export interface ConfigMapCollectorConfig {
  /** `metadata.namespace`, or `default` when unset. */
  namespace: string;
  name: string;
  /** The data key that holds the config, e.g. `config.yaml`. */
  key: string;
  config: CollectorConfig;
}

/**
 * The collector configs in one parsed manifest: every `data` value of a
 * ConfigMap that parses as a collector config. Empty for any other document.
 */
export function configMapCollectorConfigs(doc: unknown): ConfigMapCollectorConfig[] {
  if (!isRecord(doc) || doc.kind !== "ConfigMap" || !isRecord(doc.data)) return [];
  const metadata = isRecord(doc.metadata) ? doc.metadata : {};
  if (typeof metadata.name !== "string") return [];
  const namespace = typeof metadata.namespace === "string" && metadata.namespace.length > 0 ? metadata.namespace : "default";
  const out: ConfigMapCollectorConfig[] = [];
  for (const [key, text] of Object.entries(doc.data)) {
    const config = parseCollectorConfig(text);
    if (config) out.push({ namespace, name: metadata.name, key, config });
  }
  return out;
}

/** How a ConfigMap config is named in a message: `ConfigMap observability/otel-agent-config, key config.yaml`. */
export function describeConfigMapConfig(c: Pick<ConfigMapCollectorConfig, "namespace" | "name" | "key">): string {
  return `ConfigMap ${c.namespace}/${c.name}, key ${c.key}`;
}

/** One collector config found in an OpenTelemetry Operator `OpenTelemetryCollector`. */
export interface OperatorCollectorConfig {
  /** `metadata.namespace`, or `default` when unset. */
  namespace: string;
  name: string;
  config: CollectorConfig;
}

/**
 * The collector config in one parsed manifest when it is an OpenTelemetry
 * Operator `OpenTelemetryCollector`: `spec.config`, an object in v1beta1 and
 * YAML text in v1alpha1. Undefined for any other document, and for a config
 * without a `service.pipelines` map.
 */
export function operatorCollectorConfig(doc: unknown): OperatorCollectorConfig | undefined {
  if (!isRecord(doc) || doc.kind !== "OpenTelemetryCollector") return undefined;
  if (typeof doc.apiVersion !== "string" || !doc.apiVersion.startsWith("opentelemetry.io/")) return undefined;
  const metadata = isRecord(doc.metadata) ? doc.metadata : {};
  if (typeof metadata.name !== "string") return undefined;
  const raw = isRecord(doc.spec) ? doc.spec.config : undefined;
  const config = isRecord(raw)
    ? isRecord(raw.service) && isRecord(raw.service.pipelines)
      ? (raw as unknown as CollectorConfig)
      : undefined
    : parseCollectorConfig(raw);
  if (!config) return undefined;
  const namespace = typeof metadata.namespace === "string" && metadata.namespace.length > 0 ? metadata.namespace : "default";
  return { namespace, name: metadata.name, config };
}

/** How an operator CR's config is named in a message: `OpenTelemetryCollector observability/gateway, spec.config`. */
export function describeOperatorCollectorConfig(c: Pick<OperatorCollectorConfig, "namespace" | "name">): string {
  return `OpenTelemetryCollector ${c.namespace}/${c.name}, spec.config`;
}
