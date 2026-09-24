/**
 * Validate the otel lexicon's own artifacts: every built-in class is in the
 * registry, every built-in definition carries the collector pin, and every
 * built-in constructs and serializes.
 */

import type { ValidateCheck, ValidateResult } from "@intentius/chant/codegen/validate";
import { BUILTIN_CATALOG, lexiconRegistry } from "./catalog";
import * as components from "./components";
import { COLLECTOR_PIN, type ComponentClass } from "./define";
import { collectorYaml } from "./collector";

export type { ValidateCheck, ValidateResult } from "@intentius/chant/codegen/validate";

/** Every entity class the package must keep exporting. */
export const REQUIRED_NAMES = [
  "OtlpReceiver",
  "PrometheusReceiver",
  "HostMetricsReceiver",
  "FileLogReceiver",
  "BatchProcessor",
  "MemoryLimiterProcessor",
  "ResourceProcessor",
  "AttributesProcessor",
  "K8sAttributesProcessor",
  "ResourceDetectionProcessor",
  "OtlpExporter",
  "OtlpHttpExporter",
  "DebugExporter",
  "PrometheusExporter",
  "GoogleCloudExporter",
  "HealthCheckExtension",
  "PprofExtension",
  "ZPagesExtension",
  "Pipeline",
  "Service",
];

export async function validate(): Promise<ValidateResult> {
  const checks: ValidateCheck[] = [];
  const registry = lexiconRegistry();

  const missing = REQUIRED_NAMES.filter((n) => !(n in registry));
  checks.push(
    missing.length === 0
      ? { name: "required-names", ok: true }
      : { name: "required-names", ok: false, error: `Missing required names: ${missing.join(", ")}` },
  );

  const classes = (Object.entries(components) as Array<[string, unknown]>).filter(
    (e): e is [string, ComponentClass] => typeof e[1] === "function" && "definition" in (e[1] as object),
  );
  const unpinned = classes.filter(([, c]) => c.definition.pin !== COLLECTOR_PIN || !c.definition.builtin).map(([n]) => n);
  checks.push(
    unpinned.length === 0
      ? { name: "builtins-pinned", ok: true }
      : { name: "builtins-pinned", ok: false, error: `Not pinned to the collector release: ${unpinned.join(", ")}` },
  );

  const broken: string[] = [];
  for (const [name, Cls] of classes) {
    try {
      const yaml = collectorYaml([new (Cls as unknown as new (p: object) => never)({})]);
      if (!yaml.includes(Cls.definition.type)) broken.push(name);
    } catch (err) {
      broken.push(`${name} (${err instanceof Error ? err.message : String(err)})`);
    }
  }
  checks.push(
    broken.length === 0
      ? { name: "builtins-serialize", ok: true }
      : { name: "builtins-serialize", ok: false, error: `Failed to serialize: ${broken.join(", ")}` },
  );

  checks.push(
    BUILTIN_CATALOG.length === Object.keys(registry).length
      ? { name: "catalog-matches-registry", ok: true }
      : { name: "catalog-matches-registry", ok: false, error: "catalog and registry disagree" },
  );

  return { success: checks.every((c) => c.ok), checks };
}
