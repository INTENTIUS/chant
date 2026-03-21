/**
 * SLR018: GresTypes=gpu required when nodes have GPU GRES
 *
 * Without GresTypes=gpu in the global config, slurmctld ignores Gres=gpu:*
 * lines in NodeName stanzas. GPU nodes appear as normal CPU nodes and GPU
 * jobs are silently scheduled without actual GPU allocation.
 */

import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";

export const slr018: PostSynthCheck = {
  id: "SLR018",
  description: "GresTypes=gpu must be set when any NodeName has Gres=gpu:*",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    const diagnostics: PostSynthDiagnostic[] = [];

    for (const [lexicon, output] of ctx.outputs) {
      if (lexicon !== "slurm") continue;
      const content = typeof output === "string" ? output : output.primary;

      const hasGpuNode = /\bGres=gpu:/i.test(content);
      const hasGresTypes = /^GresTypes=.*\bgpu\b/m.test(content);

      if (hasGpuNode && !hasGresTypes) {
        diagnostics.push({
          checkId: "SLR018",
          severity: "error",
          message: "Nodes have Gres=gpu:* but GresTypes=gpu is not set — add GresTypes=gpu to the Cluster config",
          lexicon: "slurm",
        });
      }
    }

    return diagnostics;
  },
};
