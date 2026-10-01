/**
 * Shared plumbing for the otel post-synth checks: find the collector configs
 * in a build's output, and run the plain-function checks over them.
 */

import type { PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
import type { SerializerResult } from "@intentius/chant/serializer";
import { loadAll } from "js-yaml";
import type { Declarable } from "@intentius/chant/declarable";
import { looksLikeCollectorConfig, type CollectorConfig } from "../../model";
import { configMapCollectorConfigs, describeConfigMapConfig } from "../../configmap";
import { validateCollectorConfig, validateCollectorEntities, type CollectorIssueCode, type CollectorIssue } from "../../validate-config";

/** Where a collector config was found in the build output. */
export interface FoundCollectorConfig {
  /** The lexicon output, or the output file, the config came from. */
  source: string;
  config: CollectorConfig;
  /** Set when the config is a value in a Kubernetes ConfigMap (chant #2930). */
  configMap?: { namespace: string; name: string; key: string };
}

/**
 * Every collector config in the output: the otel lexicon's own, any YAML
 * document shaped like one, and any ConfigMap data value that parses as one
 * (how `OtelCollector`, `OtelCollectorGateway` and `GkeOtelCollector` carry
 * theirs). Parsed with js-yaml rather than `ctx.docs`, because collector
 * configs are written with flow lists (`[otlp, batch]`) that core's small
 * YAML reader keeps as strings.
 *
 * `chant build` hands each lexicon's checks only that lexicon's output, so
 * the otel checks see ConfigMaps only in a context that includes k8s output.
 * The k8s lexicon's WK8604 runs the same config checks over its own output.
 */
export function collectorConfigs(ctx: PostSynthContext): FoundCollectorConfig[] {
  const out: FoundCollectorConfig[] = [];
  for (const [lexicon, output] of ctx.outputs) {
    const texts: Array<[string, string]> =
      typeof output === "string"
        ? [[lexicon, output]]
        : [[lexicon, (output as SerializerResult).primary], ...Object.entries((output as SerializerResult).files ?? {})];
    for (const [source, text] of texts) {
      if (!text) continue;
      let docs: unknown[];
      try {
        docs = loadAll(text);
      } catch {
        continue; // not YAML, or not ours
      }
      for (const doc of docs) {
        if (typeof doc !== "object" || doc === null || Array.isArray(doc)) continue;
        if ((lexicon === "otel" && source === lexicon) || looksLikeCollectorConfig(doc)) {
          out.push({ source, config: doc as CollectorConfig });
          continue;
        }
        for (const { config, ...configMap } of configMapCollectorConfigs(doc)) {
          out.push({ source, config, configMap });
        }
      }
    }
  }
  return out;
}

function toDiagnostic(issue: CollectorIssue, found?: Omit<FoundCollectorConfig, "config">): PostSynthDiagnostic {
  const where = found?.configMap ? describeConfigMapConfig(found.configMap) : found && found.source !== "otel" ? found.source : undefined;
  return {
    checkId: issue.code,
    severity: issue.severity,
    message: where ? `${where}: ${issue.message}` : issue.message,
    ...(issue.component ? { entity: issue.component } : issue.pipeline ? { entity: issue.pipeline } : {}),
    lexicon: "otel",
  };
}

/**
 * Every config-level diagnostic (OTEL101-OTEL106, OTEL112, OTEL116 and any later
 * config check) over the collector configs in the output. `configMapsOnly`
 * keeps the configs held in ConfigMaps, which is what WK8604 reads.
 */
export function collectorConfigDiagnostics(ctx: PostSynthContext, opts: { configMapsOnly?: boolean } = {}): PostSynthDiagnostic[] {
  return collectorConfigs(ctx)
    .filter((found) => !opts.configMapsOnly || found.configMap)
    .flatMap(({ config, ...found }) => validateCollectorConfig(config).map((i) => toDiagnostic(i, found)));
}

/** Diagnostics for one config-level code (OTEL101-OTEL106, OTEL112, OTEL116) across every collector config in the output. */
export function configDiagnostics(ctx: PostSynthContext, code: CollectorIssueCode): PostSynthDiagnostic[] {
  return collectorConfigs(ctx).flatMap(({ config, ...found }) =>
    validateCollectorConfig(config)
      .filter((i) => i.code === code)
      .map((i) => toDiagnostic(i, found)),
  );
}

/** Diagnostics for one entity-level code (OTEL107-OTEL109) over the build's otel entities. */
export function entityDiagnostics(ctx: PostSynthContext, code: CollectorIssueCode): PostSynthDiagnostic[] {
  const otel: Declarable[] = [...(ctx.entities?.values() ?? [])].filter((e) => e?.lexicon === "otel");
  return validateCollectorEntities(otel)
    .filter((i) => i.code === code)
    .map((i) => toDiagnostic(i));
}
