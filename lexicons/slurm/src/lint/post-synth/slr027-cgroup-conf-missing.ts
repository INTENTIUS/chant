/**
 * SLR027: proctrack/cgroup configured but cgroup.conf is missing
 *
 * When ProctrackType=proctrack/cgroup is set, Slurm uses the cgroup plugin
 * to manage process tracking. Without a cgroup.conf file, ConstrainRAMSpace
 * defaults to false — runaway jobs can consume all node memory and cause OOM
 * kills of unrelated processes, including slurmstepd itself.
 *
 * Fix: add a CgroupConf resource to your project with ConstrainRAMSpace=true.
 */

import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";

export const slr027: PostSynthCheck = {
  id: "SLR027",
  description: "proctrack/cgroup set but cgroup.conf missing — memory constraints inactive",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    const diagnostics: PostSynthDiagnostic[] = [];

    for (const [lexicon, output] of ctx.outputs) {
      if (lexicon !== "slurm") continue;

      const content = typeof output === "string" ? output : (output as { primary: string }).primary;
      const files = typeof output === "object" && output !== null
        ? (output as { files?: Record<string, string> }).files ?? {}
        : {};

      const hasCgroupProctrack = /^ProctrackType=proctrack\/cgroup/m.test(content);
      const hasCgroupConf = "cgroup.conf" in files;

      if (hasCgroupProctrack && !hasCgroupConf) {
        diagnostics.push({
          checkId: "SLR027",
          severity: "warning",
          message:
            "ProctrackType=proctrack/cgroup requires cgroup.conf for memory/core/device constraints. " +
            "Without it, ConstrainRAMSpace defaults to false — runaway jobs can consume all node memory. " +
            "Add a CgroupConf resource.",
          lexicon: "slurm",
        });
      }
    }

    return diagnostics;
  },
};
