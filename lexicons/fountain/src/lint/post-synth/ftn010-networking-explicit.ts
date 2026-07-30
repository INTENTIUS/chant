import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";

/**
 * FTN010: Environments must state their networking intent.
 *
 * Fountain defaults `networking_type` to `unrestricted` when omitted —
 * an open-network sandbox by silence. Every declared Environment must set
 * `networking_type` explicitly so the security posture is a reviewed,
 * diffable decision.
 */
export const networkingExplicitCheck: PostSynthCheck = {
  id: "FTN010",
  description: "Environment declarations must set networking_type explicitly",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    const diagnostics: PostSynthDiagnostic[] = [];

    for (const [name, entity] of ctx.entities) {
      if (entity.entityType !== "Fountain::V1::Environment") continue;
      const props = entity as unknown as Record<string, unknown>;
      if (props.networking_type === undefined) {
        diagnostics.push({
          checkId: "FTN010",
          severity: "warning",
          message:
            `Environment "${name}" does not set networking_type — fountain defaults to ` +
            `"unrestricted" (open network). State the intent explicitly.`,
          entity: name,
          lexicon: "fountain",
        });
      }
    }

    return diagnostics;
  },
};
