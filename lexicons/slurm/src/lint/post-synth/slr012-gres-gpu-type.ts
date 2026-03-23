/**
 * SLR012: GPU GRES must specify type
 *
 * Gres=gpu:8 (no type) works but prevents per-model GPU scheduling.
 * Gres=gpu:a100:8 enables srun --gres=gpu:a100:N targeting and proper
 * accounting. On heterogeneous GPU clusters without type, Slurm cannot
 * distinguish A100 from H100 nodes — all appear identical.
 */

import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";

// Matches "gpu:N" but NOT "gpu:typename:N" or "gpu:typename"
const UNTYPED_GPU_RE = /\bgpu:(\d+)\b/;

export const slr012: PostSynthCheck = {
  id: "SLR012",
  description: "GPU GRES should specify type (e.g. gpu:a100:8 not gpu:8)",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    const diagnostics: PostSynthDiagnostic[] = [];

    for (const [lexicon, output] of ctx.outputs) {
      if (lexicon !== "slurm") continue;
      const content = typeof output === "string" ? output : output.primary;

      for (const match of content.matchAll(/^NodeName=(\S+)[^\n]*\bGres=([^\n]+)/gm)) {
        const nodeName = match[1];
        const gres = match[2];

        for (const gresEntry of gres.split(",")) {
          if (UNTYPED_GPU_RE.test(gresEntry.trim())) {
            diagnostics.push({
              checkId: "SLR012",
              severity: "warning",
              message: `Node "${nodeName}" Gres contains untyped GPU "${gresEntry.trim()}" — use gpu:<type>:<count> (e.g. gpu:a100:8)`,
              entity: nodeName,
              lexicon: "slurm",
            });
          }
        }
      }
    }

    return diagnostics;
  },
};
