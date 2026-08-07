import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
import { readString } from "../../entity-props";
import { GVC, WORKLOAD, entitiesOfType } from "./helpers";

/**
 * CPL011: internal firewall opened to the whole org.
 *
 * `same-org` lets every workload in every GVC reach this one, which crosses the
 * boundary a GVC exists to draw. `same-gvc` and `workload-list` cover almost
 * every real case, and `workload-list` works cross-GVC when that is genuinely
 * needed.
 */
export const internalFirewallScopeCheck: PostSynthCheck = {
  id: "CPL011",
  description: "Internal firewall should not be opened to the entire org",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    const diagnostics: PostSynthDiagnostic[] = [];

    for (const [name, entity] of entitiesOfType(ctx.entities, WORKLOAD)) {
      const allowType = readString(entity, "spec", "firewallConfig", "internal", "inboundAllowType");
      if (allowType !== "same-org") continue;

      diagnostics.push({
        checkId: "CPL011",
        severity: "warning",
        message:
          `Workload "${name}" sets internal inboundAllowType "same-org", so every workload in the org — ` +
          `including other GVCs — can reach it. Prefer "same-gvc", or "workload-list" with the specific ` +
          `workloads (which also works across GVCs).`,
        entity: name,
        lexicon: "cpln",
      });
    }

    return diagnostics;
  },
};
