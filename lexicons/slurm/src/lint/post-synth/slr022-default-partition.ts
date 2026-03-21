/**
 * SLR022: Exactly one Default=YES partition required
 *
 * Slurm requires exactly one partition with Default=YES. If none is set,
 * srun/sbatch jobs without --partition fail. If multiple are set, only
 * the last one in slurm.conf takes effect (silent config error).
 */

import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";

export const slr022: PostSynthCheck = {
  id: "SLR022",
  description: "Exactly one partition must have Default=YES",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    const diagnostics: PostSynthDiagnostic[] = [];

    for (const [lexicon, output] of ctx.outputs) {
      if (lexicon !== "slurm") continue;
      const content = typeof output === "string" ? output : output.primary;

      const defaultMatches = [...content.matchAll(/^PartitionName=\S+[^\n]*\bDefault=YES\b/gm)];

      if (defaultMatches.length === 0) {
        diagnostics.push({
          checkId: "SLR022",
          severity: "warning",
          message: "No partition has Default=YES — jobs submitted without --partition will fail",
          lexicon: "slurm",
        });
      } else if (defaultMatches.length > 1) {
        diagnostics.push({
          checkId: "SLR022",
          severity: "warning",
          message: `${defaultMatches.length} partitions have Default=YES — only the last one takes effect`,
          lexicon: "slurm",
        });
      }
    }

    return diagnostics;
  },
};
