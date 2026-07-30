import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";

/**
 * FTN011: `unrestricted` networking is a warning by default.
 *
 * Fountain sandboxes run untrusted agent code; an open-network sandbox is
 * a real posture some workloads need, but it should read as a deliberate
 * exception in review. Projects hosting untrusted-agent environments
 * (concierge-class) should promote this to error via project rules.
 */
export const noUnrestrictedNetworkingCheck: PostSynthCheck = {
  id: "FTN011",
  description: "Environments should prefer networking_type: limited over unrestricted",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    const diagnostics: PostSynthDiagnostic[] = [];
    for (const [name, entity] of ctx.entities) {
      if (entity.entityType !== "Fountain::V1::Environment") continue;
      const props = entity as unknown as Record<string, unknown>;
      if (props.networking_type === "unrestricted") {
        diagnostics.push({
          checkId: "FTN011",
          severity: "warning",
          message:
            `Environment "${name}" uses networking_type: unrestricted — an open-network ` +
            `sandbox. Prefer "limited" with allowed_hosts; keep unrestricted only as a ` +
            `reviewed exception.`,
          entity: name,
          lexicon: "fountain",
        });
      }
    }
    return diagnostics;
  },
};
