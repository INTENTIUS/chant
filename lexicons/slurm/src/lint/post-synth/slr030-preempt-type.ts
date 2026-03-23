/**
 * SLR030: Partition PreemptMode set but PreemptType defaults to preempt/none
 *
 * Setting PreemptMode on a partition (CANCEL, REQUEUE, SUSPEND, etc.) has no
 * effect unless PreemptType is set to a functional plugin (preempt/qos or
 * preempt/partition_prio). The default PreemptType=preempt/none disables all
 * preemption regardless of per-partition PreemptMode values.
 *
 * Fix: add PreemptType=preempt/qos (for QOS-based preemption) or
 * PreemptType=preempt/partition_prio (for partition priority preemption)
 * to your Cluster resource.
 */

import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";

export const slr030: PostSynthCheck = {
  id: "SLR030",
  description: "Partition PreemptMode set but PreemptType=preempt/none (default) — preemption has no effect",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    const diagnostics: PostSynthDiagnostic[] = [];

    for (const [lexicon, output] of ctx.outputs) {
      if (lexicon !== "slurm") continue;

      const content = typeof output === "string" ? output : (output as { primary: string }).primary;

      const hasEffectivePreemptType = /^PreemptType=preempt\/(qos|partition_prio)/m.test(content);
      if (hasEffectivePreemptType) continue;

      const partitionLines = content.split("\n").filter((l) => l.startsWith("PartitionName="));
      for (const line of partitionLines) {
        const modeMatch = line.match(/PreemptMode=(\S+)/);
        if (!modeMatch || modeMatch[1] === "OFF") continue;

        const nameMatch = line.match(/PartitionName=(\S+)/);
        const partName = nameMatch ? nameMatch[1] : "unknown";

        diagnostics.push({
          checkId: "SLR030",
          severity: "warning",
          message:
            `Partition '${partName}' has PreemptMode=${modeMatch[1]} but PreemptType defaults to ` +
            "preempt/none — preemption will have no effect. Set PreemptType=preempt/qos or " +
            "preempt/partition_prio in the cluster config.",
          lexicon: "slurm",
        });
      }
    }

    return diagnostics;
  },
};
