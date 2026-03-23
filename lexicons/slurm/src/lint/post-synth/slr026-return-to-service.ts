/**
 * SLR026: CLOUD nodes present but ReturnToService not configured
 *
 * CLOUD nodes are provisioned on-demand (spot/autoscaling). When a CLOUD node
 * is resumed after suspension, it re-registers with slurmctld. Without
 * ReturnToService=1, the node stays in DOWN state after re-registration and
 * jobs will never be dispatched to it.
 *
 * Set ReturnToService=1 (node returns to IDLE when re-registered) or =2
 * (node always returns to IDLE, even if it was previously DOWN due to error).
 */

import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";

export const slr026: PostSynthCheck = {
  id: "SLR026",
  description: "CLOUD nodes present but ReturnToService not configured",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    const diagnostics: PostSynthDiagnostic[] = [];

    for (const [lexicon, output] of ctx.outputs) {
      if (lexicon !== "slurm") continue;

      const content = typeof output === "string" ? output : (output as { primary: string }).primary;

      const hasCloudNodes = /^NodeName=\S+\s[^\n]*State=CLOUD/m.test(content);
      const hasReturnToService = /^ReturnToService=/m.test(content);

      if (hasCloudNodes && !hasReturnToService) {
        diagnostics.push({
          checkId: "SLR026",
          severity: "warning",
          message:
            "CLOUD nodes present but ReturnToService not configured. " +
            "Set ReturnToService=1 so nodes can re-register after suspend/resume.",
          lexicon: "slurm",
        });
      }
    }

    return diagnostics;
  },
};
