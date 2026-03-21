/**
 * SLRC002: Deprecated SelectType
 *
 * SelectType=select/cons_res is deprecated since Slurm 21.08.
 * The replacement is select/cons_tres which provides the same functionality
 * with additional support for tracking TRES (Trackable RESources) including
 * GPUs, licenses, and custom GRES. Using cons_res on GPU clusters silently
 * breaks GPU accounting.
 */

import type { LintRule, LintDiagnostic, LintContext } from "@intentius/chant/lint/rule";

export const selectTypeDeprecated: LintRule = {
  id: "SLRC002",
  severity: "warning",
  category: "correctness",
  description: "SelectType=select/cons_res is deprecated — use select/cons_tres",

  check(context: LintContext): LintDiagnostic[] {
    const diagnostics: LintDiagnostic[] = [];

    for (const [name, entity] of context.entities) {
      const et = (entity as Record<string, unknown>).entityType as string;
      if (et !== "Slurm::Conf::Cluster") continue;

      const props = (entity as { props?: Record<string, unknown> }).props ?? {};
      if (props.SelectType === "select/cons_res") {
        diagnostics.push({
          ruleId: "SLRC002",
          severity: "warning",
          message: `Cluster "${name}" uses deprecated SelectType=select/cons_res — replace with select/cons_tres`,
          entity: name,
          fix: 'Change SelectType to "select/cons_tres" and add SelectTypeParameters: "CR_Core_Memory"',
        });
      }
    }

    return diagnostics;
  },
};
