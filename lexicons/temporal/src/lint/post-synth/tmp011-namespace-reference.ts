/**
 * TMP011: SearchAttribute references an undeclared namespace
 *
 * If SearchAttribute.namespace is set to a value X, there must be a
 * TemporalNamespace entity with name === X in the project. A missing
 * namespace means the search attribute create command will fail at runtime.
 */

import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";

export const tmp011: PostSynthCheck = {
  id: "TMP011",
  description: "SearchAttribute.namespace must reference a declared TemporalNamespace entity",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    const diagnostics: PostSynthDiagnostic[] = [];

    // Collect declared namespace names
    const declaredNamespaces = new Set<string>();
    for (const [, entity] of ctx.entities) {
      const et = (entity as Record<string, unknown>).entityType as string;
      if (et !== "Temporal::Namespace") continue;
      const props = (entity as { props?: Record<string, unknown> }).props ?? {};
      const name = props.name as string | undefined;
      if (name) declaredNamespaces.add(name);
    }

    // Check each SearchAttribute that specifies a namespace
    for (const [entityKey, entity] of ctx.entities) {
      const et = (entity as Record<string, unknown>).entityType as string;
      if (et !== "Temporal::SearchAttribute") continue;

      const props = (entity as { props?: Record<string, unknown> }).props ?? {};
      const ns = props.namespace as string | undefined;
      if (!ns) continue; // no namespace specified — applies globally, OK

      if (!declaredNamespaces.has(ns)) {
        diagnostics.push({
          checkId: "TMP011",
          severity: "error",
          message: `SearchAttribute "${entityKey}" references namespace "${ns}" which is not declared — add a TemporalNamespace with name "${ns}"`,
          lexicon: "temporal",
        });
      }
    }

    return diagnostics;
  },
};
