/**
 * SLR015: cons_tres without SelectTypeParameters
 *
 * When SelectType=select/cons_tres is set without SelectTypeParameters,
 * Slurm defaults to CPU-only scheduling (no memory tracking). For EDA
 * and GPU workloads, CR_Core_Memory is the standard configuration that
 * enables per-job memory limits and proper fairshare accounting.
 */

import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";

export const slr015: PostSynthCheck = {
  id: "SLR015",
  description: "SelectType=select/cons_tres should be paired with SelectTypeParameters",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    const diagnostics: PostSynthDiagnostic[] = [];

    for (const [lexicon, output] of ctx.outputs) {
      if (lexicon !== "slurm") continue;
      const content = typeof output === "string" ? output : output.primary;

      const hasConsTres = /^SelectType=select\/cons_tres/m.test(content);
      const hasParams = /^SelectTypeParameters=/m.test(content);

      if (hasConsTres && !hasParams) {
        diagnostics.push({
          checkId: "SLR015",
          severity: "warning",
          message: "SelectType=select/cons_tres is set without SelectTypeParameters — add SelectTypeParameters=CR_Core_Memory",
          lexicon: "slurm",
        });
      }
    }

    return diagnostics;
  },
};
