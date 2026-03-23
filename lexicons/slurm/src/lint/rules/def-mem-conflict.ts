/**
 * SLRC003: DefMemPerCPU + DefMemPerNode conflict
 *
 * Setting both DefMemPerCPU and DefMemPerNode on the same Partition is a
 * configuration error — Slurm accepts only one. The slurmctld will log a
 * warning and use DefMemPerNode, silently ignoring DefMemPerCPU. On multi-
 * socket GPU nodes this leads to jobs being granted less memory than expected.
 */

import type { LintRule, LintDiagnostic, LintContext } from "@intentius/chant/lint/rule";

export const defMemConflict: LintRule = {
  id: "SLRC003",
  severity: "error",
  category: "correctness",
  description: "DefMemPerCPU and DefMemPerNode must not both be set on the same Partition",

  check(context: LintContext): LintDiagnostic[] {
    const diagnostics: LintDiagnostic[] = [];

    for (const [name, entity] of context.entities) {
      const et = (entity as Record<string, unknown>).entityType as string;
      if (et !== "Slurm::Conf::Partition") continue;

      const props = (entity as { props?: Record<string, unknown> }).props ?? {};
      const hasPerCPU = props.DefMemPerCPU !== undefined && props.DefMemPerCPU !== null;
      const hasPerNode = props.DefMemPerNode !== undefined && props.DefMemPerNode !== null;

      if (hasPerCPU && hasPerNode) {
        diagnostics.push({
          ruleId: "SLRC003",
          severity: "error",
          message: `Partition "${name}" sets both DefMemPerCPU and DefMemPerNode — remove one`,
          entity: name,
          fix: "Use DefMemPerCPU for CPU partitions; DefMemPerNode for GPU/memory-optimized partitions",
        });
      }
    }

    return diagnostics;
  },
};
