/**
 * SLR010: ClusterName and ControlMachine required
 *
 * The two mandatory fields for any slurm.conf. Without them slurmctld
 * refuses to start. Catches cases where a Cluster entity is missing or
 * these fields were accidentally left unset.
 */

import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";

export const slr010: PostSynthCheck = {
  id: "SLR010",
  description: "ClusterName and ControlMachine are required in slurm.conf",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    const diagnostics: PostSynthDiagnostic[] = [];

    for (const [lexicon, output] of ctx.outputs) {
      if (lexicon !== "slurm") continue;
      const content = typeof output === "string" ? output : output.primary;

      const hasClusterName = /^ClusterName=/m.test(content);
      const hasControlMachine = /^ControlMachine=/m.test(content);

      if (!hasClusterName) {
        diagnostics.push({
          checkId: "SLR010",
          severity: "error",
          message: "slurm.conf is missing ClusterName — add a Cluster resource with ClusterName set",
          lexicon: "slurm",
        });
      }

      if (!hasControlMachine) {
        diagnostics.push({
          checkId: "SLR010",
          severity: "error",
          message: "slurm.conf is missing ControlMachine — add a Cluster resource with ControlMachine set",
          lexicon: "slurm",
        });
      }
    }

    return diagnostics;
  },
};
