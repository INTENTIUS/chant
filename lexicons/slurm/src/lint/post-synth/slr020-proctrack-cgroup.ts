/**
 * SLR020: ProctrackType=proctrack/linuxproc is unsafe
 *
 * proctrack/linuxproc uses process groups for job cleanup. Orphaned
 * processes (daemonized or setsid'd children) survive job completion
 * and continue consuming CPU and memory. On GPU clusters this leads
 * to GPU memory leaks across jobs. proctrack/cgroup is required for
 * reliable job cleanup in EDA and ML workloads.
 */

import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";

export const slr020: PostSynthCheck = {
  id: "SLR020",
  description: "ProctrackType=proctrack/linuxproc is unsafe for production — use proctrack/cgroup",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    const diagnostics: PostSynthDiagnostic[] = [];

    for (const [lexicon, output] of ctx.outputs) {
      if (lexicon !== "slurm") continue;
      const content = typeof output === "string" ? output : output.primary;

      if (/^ProctrackType=proctrack\/linuxproc/m.test(content)) {
        diagnostics.push({
          checkId: "SLR020",
          severity: "warning",
          message: "ProctrackType=proctrack/linuxproc does not reliably clean up orphaned processes — use proctrack/cgroup",
          lexicon: "slurm",
        });
      }
    }

    return diagnostics;
  },
};
