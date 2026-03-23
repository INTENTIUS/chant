/**
 * SLR028: Multi-node GPU cluster without TopologyPlugin
 *
 * When a cluster has multiple GPU nodes (NodeName expression with '[') and GPU
 * GRES configured but no TopologyPlugin set, Slurm cannot co-locate NCCL/MPI
 * training jobs on the same network switch. This causes unnecessary cross-switch
 * traffic which degrades multi-node training throughput significantly.
 *
 * Fix: add TopologyPlugin=topology/tree to your Cluster resource and Switch
 * resources to generate topology.conf describing your network hierarchy.
 */

import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";

export const slr028: PostSynthCheck = {
  id: "SLR028",
  description: "Multi-node GPU cluster without TopologyPlugin — NCCL co-location disabled",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    const diagnostics: PostSynthDiagnostic[] = [];

    for (const [lexicon, output] of ctx.outputs) {
      if (lexicon !== "slurm") continue;

      const content = typeof output === "string" ? output : (output as { primary: string }).primary;

      const hasGpuGres = /^GresTypes=gpu/m.test(content);
      const hasMultiNodeGpu = /^NodeName=\S*\[.*?Gres=gpu:/m.test(content);
      const hasTopology = /^TopologyPlugin=/m.test(content);

      if (hasGpuGres && hasMultiNodeGpu && !hasTopology) {
        diagnostics.push({
          checkId: "SLR028",
          severity: "warning",
          message:
            "Multi-node GPU cluster detected but TopologyPlugin not configured. " +
            "Add TopologyPlugin=topology/tree and Switch resources (topology.conf) to " +
            "co-locate NCCL/MPI training jobs on the same network switch.",
          lexicon: "slurm",
        });
      }
    }

    return diagnostics;
  },
};
