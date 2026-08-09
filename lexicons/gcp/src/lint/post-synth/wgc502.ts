/**
 * WGC502: Org Policy Guardrail Defines No Rules 
 *
 * Flags OrgPolicyPolicy resources with no rules (and no reset). A rule-less
 * org policy binds a constraint to nothing — the usual leftover of a
 * guardrail whose rules were removed while the policy object was kept.
 */

import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
import { parseGcpManifests, getResourceName } from "./gcp-helpers";
import { orgPolicyRules, orgPolicySpec } from "./wgc501";

export const wgc502: PostSynthCheck = {
  id: "WGC502",
  description: "Org Policy guardrail defines no rules — it binds its constraint to nothing",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    const diagnostics: PostSynthDiagnostic[] = [];

    for (const [, output] of ctx.outputs) {
      if (typeof output !== "string") continue;

      for (const manifest of parseGcpManifests(output)) {
        if (manifest.kind !== "OrgPolicyPolicy") continue;
        if (orgPolicySpec(manifest).reset === true) continue; // WGC501's finding
        if (orgPolicyRules(manifest).length > 0) continue;

        const name = getResourceName(manifest);
        diagnostics.push({
          checkId: "WGC502",
          severity: "error",
          message: `OrgPolicyPolicy "${name}" defines no rules — the guardrail constrains nothing`,
          entity: name,
          lexicon: "gcp",
        });
      }
    }

    return diagnostics;
  },
};
