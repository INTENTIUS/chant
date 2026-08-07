import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
import { readArray } from "../../entity-props";
import { WORKLOAD, entitiesOfType } from "./helpers";

const ANY_ADDRESS = "0.0.0.0/0";

/**
 * CPL010: a workload that may call out to the entire internet.
 *
 * Inbound `0.0.0.0/0` is how a public service is *supposed* to be written, so
 * it is not flagged. Outbound `0.0.0.0/0` is different: it is rarely required,
 * it is the egress path for anything that gets a foothold in the container,
 * and Control Plane supports hostname rules (with wildcards) precisely so it
 * does not have to be all-or-nothing.
 */
export const unrestrictedOutboundCheck: PostSynthCheck = {
  id: "CPL010",
  description: "Workloads should not allow outbound traffic to every address",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    const diagnostics: PostSynthDiagnostic[] = [];

    for (const [name, entity] of entitiesOfType(ctx.entities, WORKLOAD)) {
      const outbound = readArray(entity, "spec", "firewallConfig", "external", "outboundAllowCIDR");
      if (!outbound.includes(ANY_ADDRESS)) continue;

      diagnostics.push({
        checkId: "CPL010",
        severity: "warning",
        message:
          `Workload "${name}" allows outbound traffic to ${ANY_ADDRESS}. Narrow it to the CIDRs it ` +
          `actually calls, or use \`outboundAllowHostname\` (wildcards like "*.amazonaws.com" are ` +
          `supported) so egress is bounded.`,
        entity: name,
        lexicon: "cpln",
      });
    }

    return diagnostics;
  },
};
