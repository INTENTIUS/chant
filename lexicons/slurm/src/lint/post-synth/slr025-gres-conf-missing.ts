/**
 * SLR025: GPU nodes configured but no GresNode resources defined
 *
 * When any NodeName stanza includes Gres=gpu:*, slurmctld requires a matching
 * gres.conf entry so the GRES plugin can bind the physical devices. Without
 * gres.conf, GPU jobs may fail at scheduling or the GPUs may be double-counted.
 *
 * Fix: add GresNode resources to your project, or set AutoDetect=nvml in gresConf.
 */

import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";

export const slr025: PostSynthCheck = {
  id: "SLR025",
  description: "GPU nodes configured but no GresNode resources defined (gres.conf missing)",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    const diagnostics: PostSynthDiagnostic[] = [];

    for (const [lexicon, output] of ctx.outputs) {
      if (lexicon !== "slurm") continue;

      const content = typeof output === "string" ? output : (output as { primary: string }).primary;
      const files = typeof output === "object" && output !== null
        ? (output as { files?: Record<string, string> }).files ?? {}
        : {};

      const hasGpuNodes = /^NodeName=\S+\s[^\n]*Gres=gpu:/m.test(content);
      const hasGresConf = "gres.conf" in files;

      if (hasGpuNodes && !hasGresConf) {
        diagnostics.push({
          checkId: "SLR025",
          severity: "warning",
          message:
            "GPU nodes configured but no GresNode resources defined — slurmctld requires gres.conf for GRES binding. " +
            "Add GresNode resources or set autoDetect: 'nvml' in gresConf when using GpuPartition.",
          lexicon: "slurm",
        });
      }
    }

    return diagnostics;
  },
};
