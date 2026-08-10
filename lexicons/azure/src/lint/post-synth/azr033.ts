/**
 * AZR033: Subscriptions May Leave the Tenant 
 *
 * Flags a Microsoft.Subscription/policies resource that sets
 * blockSubscriptionsLeavingTenant to false — the tenant-level leave-block
 * the landing-zone foundation declares, explicitly weakened.
 */

import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
import { parseArmTemplate } from "./arm-refs";

export const azr033: PostSynthCheck = {
  id: "AZR033",
  description: "Tenant subscription policy does not block subscriptions from leaving",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    const diagnostics: PostSynthDiagnostic[] = [];

    for (const [_lexicon, output] of ctx.outputs) {
      const template = parseArmTemplate(output);
      if (!template?.resources) continue;

      for (const resource of template.resources) {
        if (resource.type !== "Microsoft.Subscription/policies") continue;
        if (resource.properties?.blockSubscriptionsLeavingTenant !== false) continue;

        const name = typeof resource.name === "string" ? resource.name : String(resource.name);
        diagnostics.push({
          checkId: "AZR033",
          severity: "error",
          message: `Subscription tenant policy "${name}" sets blockSubscriptionsLeavingTenant: false — subscriptions can be moved out of the tenant`,
          entity: name,
          lexicon: "azure",
        });
      }
    }

    return diagnostics;
  },
};
