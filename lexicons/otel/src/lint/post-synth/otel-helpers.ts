/**
 * Shared plumbing for the otel post-synth checks: find the collector configs
 * in a build's output, and run the plain-function checks over them.
 */

import type { PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
import type { SerializerResult } from "@intentius/chant/serializer";
import { loadAll } from "js-yaml";
import type { Declarable } from "@intentius/chant/declarable";
import { looksLikeCollectorConfig, type CollectorConfig } from "../../model";
import { validateCollectorConfig, validateCollectorEntities, type CollectorIssueCode, type CollectorIssue } from "../../validate-config";

/**
 * Every collector config in the output: the otel lexicon's own, and any YAML
 * document shaped like one. Parsed with js-yaml rather than `ctx.docs`,
 * because collector configs are written with flow lists (`[otlp, batch]`)
 * that core's small YAML reader keeps as strings.
 */
export function collectorConfigs(ctx: PostSynthContext): Array<{ source: string; config: CollectorConfig }> {
  const out: Array<{ source: string; config: CollectorConfig }> = [];
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
        }
      }
    }
  }
  return out;
}

function toDiagnostic(issue: CollectorIssue, source?: string): PostSynthDiagnostic {
  return {
    checkId: issue.code,
    severity: issue.severity,
    message: source && source !== "otel" ? `${source}: ${issue.message}` : issue.message,
    ...(issue.component ? { entity: issue.component } : issue.pipeline ? { entity: issue.pipeline } : {}),
    lexicon: "otel",
  };
}

/** Diagnostics for one config-level code (OTEL101-OTEL106) across every collector config in the output. */
export function configDiagnostics(ctx: PostSynthContext, code: CollectorIssueCode): PostSynthDiagnostic[] {
  return collectorConfigs(ctx).flatMap(({ source, config }) =>
    validateCollectorConfig(config)
      .filter((i) => i.code === code)
      .map((i) => toDiagnostic(i, source)),
  );
}

/** Diagnostics for one entity-level code (OTEL107-OTEL109) over the build's otel entities. */
export function entityDiagnostics(ctx: PostSynthContext, code: CollectorIssueCode): PostSynthDiagnostic[] {
  const otel: Declarable[] = [...(ctx.entities?.values() ?? [])].filter((e) => e?.lexicon === "otel");
  return validateCollectorEntities(otel)
    .filter((i) => i.code === code)
    .map((i) => toDiagnostic(i));
}
