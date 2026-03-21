/**
 * SLR016: SelectType=select/cons_res is deprecated
 *
 * select/cons_res was deprecated in Slurm 21.08. It cannot track GPU GRES,
 * license resources, or fine-grained TRES accounting. Clusters using it
 * silently mis-schedule GPU workloads. Replace with select/cons_tres.
 */

import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";

export const slr016: PostSynthCheck = {
  id: "SLR016",
  description: "SelectType=select/cons_res is deprecated — use select/cons_tres",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    const diagnostics: PostSynthDiagnostic[] = [];

    for (const [lexicon, output] of ctx.outputs) {
      if (lexicon !== "slurm") continue;
      const content = typeof output === "string" ? output : output.primary;

      if (/^SelectType=select\/cons_res/m.test(content)) {
        diagnostics.push({
          checkId: "SLR016",
          severity: "warning",
          message: "SelectType=select/cons_res is deprecated since Slurm 21.08 — replace with select/cons_tres",
          lexicon: "slurm",
        });
      }
    }

    return diagnostics;
  },
};
