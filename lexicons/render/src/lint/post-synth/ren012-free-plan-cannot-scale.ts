/**
 * REN012: The free instance type cannot scale.
 *
 * Render's `free` plan runs a single instance and cannot autoscale; a
 * `numInstances > 1` or an enabled `autoscaling` block on a free service is
 * rejected at create/patch time. Persistent disks are also unavailable on
 * free. Catch all three at synth time with a message that says which.
 */

import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
import { readProps, isService, kindOf } from "./render-helpers";

export const ren012: PostSynthCheck = {
  id: "REN012",
  description: "A free-plan service cannot set numInstances > 1, autoscaling, or a disk",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    const diagnostics: PostSynthDiagnostic[] = [];

    for (const [name, entity] of ctx.entities) {
      if (!isService(entity)) continue;
      const details = readProps(readProps(entity).serviceDetails);
      if (details.plan !== "free") continue;

      const problems: string[] = [];
      if (typeof details.numInstances === "number" && details.numInstances > 1) problems.push(`numInstances: ${details.numInstances}`);
      const autoscaling = readProps(details.autoscaling);
      if (autoscaling.enabled === true) problems.push("autoscaling");
      if (details.disk !== undefined) problems.push("a disk");
      if (problems.length > 0) {
        diagnostics.push({
          checkId: "REN012",
          severity: "error",
          message: `${kindOf(entity)} "${name}" is on the free plan but sets ${problems.join(", ")} — the free instance type runs one instance, cannot autoscale, and has no persistent disk; pick a paid plan (starter or above)`,
          entity: name,
          lexicon: "render",
        });
      }
    }

    return diagnostics;
  },
};
