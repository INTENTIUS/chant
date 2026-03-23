/**
 * SLR017: DefMemPerCPU and DefMemPerNode conflict
 *
 * Setting both on the same partition causes slurmctld to log a warning and
 * silently use DefMemPerNode, ignoring DefMemPerCPU. This catches the
 * conflict in the serialized output (after all entities are merged).
 */

import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";

export const slr017: PostSynthCheck = {
  id: "SLR017",
  description: "DefMemPerCPU and DefMemPerNode must not both appear on the same PartitionName line",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    const diagnostics: PostSynthDiagnostic[] = [];

    for (const [lexicon, output] of ctx.outputs) {
      if (lexicon !== "slurm") continue;
      const content = typeof output === "string" ? output : output.primary;

      for (const match of content.matchAll(/^PartitionName=(\S+)[^\n]+/gm)) {
        const line = match[0];
        const partName = match[1];

        const hasPerCPU = /\bDefMemPerCPU=/.test(line);
        const hasPerNode = /\bDefMemPerNode=/.test(line);

        if (hasPerCPU && hasPerNode) {
          diagnostics.push({
            checkId: "SLR017",
            severity: "error",
            message: `Partition "${partName}" has both DefMemPerCPU and DefMemPerNode — remove one`,
            entity: partName,
            lexicon: "slurm",
          });
        }
      }
    }

    return diagnostics;
  },
};
