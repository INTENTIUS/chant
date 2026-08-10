/**
 * AZR031: Policy Assignment Not Enforced 
 *
 * Flags Microsoft.Authorization/policyAssignments with enforcementMode
 * DoNotEnforce. The assignment stays visible in the tree while denying
 * nothing — the Azure shape of a disabled guardrail.
 */

import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
import { parseArmTemplate } from "./arm-refs";

export const azr031: PostSynthCheck = {
  id: "AZR031",
  description: "Policy assignment has enforcementMode DoNotEnforce — the guardrail is disabled",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    const diagnostics: PostSynthDiagnostic[] = [];

    for (const [_lexicon, output] of ctx.outputs) {
      const template = parseArmTemplate(output);
      if (!template?.resources) continue;

      for (const resource of template.resources) {
        if (resource.type !== "Microsoft.Authorization/policyAssignments") continue;
        const mode = resource.properties?.enforcementMode;
        if (mode !== "DoNotEnforce") continue;

        const name = typeof resource.name === "string" ? resource.name : String(resource.name);
        diagnostics.push({
          checkId: "AZR031",
          severity: "error",
          message: `Policy assignment "${name}" has enforcementMode DoNotEnforce — the guardrail is assigned but enforces nothing`,
          entity: name,
          lexicon: "azure",
        });
      }
    }

    return diagnostics;
  },
};
