/**
 * SLR021: PriorityWeightFairshare too low
 *
 * When PriorityWeightFairshare is set but too small (< 1000), the fairshare
 * component is effectively noise and all jobs get similar priority regardless
 * of account usage. For EDA multi-team clusters, fairshare needs sufficient
 * weight to prevent one team from monopolizing resources.
 *
 * Rule of thumb: PriorityWeightFairshare >= 1000 (OpenHPC recommendation
 * is 10000 for significant differentiation).
 */

import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";

const MIN_FAIRSHARE_WEIGHT = 1000;

export const slr021: PostSynthCheck = {
  id: "SLR021",
  description: `PriorityWeightFairshare should be >= ${MIN_FAIRSHARE_WEIGHT} for meaningful fairshare scheduling`,

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    const diagnostics: PostSynthDiagnostic[] = [];

    for (const [lexicon, output] of ctx.outputs) {
      if (lexicon !== "slurm") continue;
      const content = typeof output === "string" ? output : output.primary;

      const match = content.match(/^PriorityWeightFairshare=(\d+)/m);
      if (!match) continue;

      const value = parseInt(match[1], 10);
      if (value < MIN_FAIRSHARE_WEIGHT) {
        diagnostics.push({
          checkId: "SLR021",
          severity: "warning",
          message: `PriorityWeightFairshare=${value} is too small — fairshare will have negligible effect. Use >= ${MIN_FAIRSHARE_WEIGHT} (recommended: 10000)`,
          lexicon: "slurm",
        });
      }
    }

    return diagnostics;
  },
};
