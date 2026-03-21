/**
 * SLRS001: MaxTime format
 *
 * Partition MaxTime= must be "UNLIMITED" or a valid Slurm duration string
 * (D-HH:MM:SS, HH:MM:SS, MM:SS, or plain minutes). Plain integers are
 * valid (minutes) but bare strings that don't match are silently ignored
 * by Slurm — this rule catches typos like "48h" or "2d".
 */

import type { LintRule, LintDiagnostic, LintContext } from "@intentius/chant/lint/rule";

// Valid Slurm duration: optional "D-" prefix, then HH:MM:SS or MM:SS or MM
const SLURM_DURATION_RE = /^\d+(-\d{1,2}:\d{2}(:\d{2})?)?$|^\d+:\d{2}(:\d{2})?$/;

export const maxTimeFormat: LintRule = {
  id: "SLRS001",
  severity: "warning",
  category: "style",
  description: 'MaxTime must be "UNLIMITED" or a valid Slurm duration (D-HH:MM:SS)',

  check(context: LintContext): LintDiagnostic[] {
    const diagnostics: LintDiagnostic[] = [];

    for (const [name, entity] of context.entities) {
      const et = (entity as Record<string, unknown>).entityType as string;
      if (et !== "Slurm::Conf::Partition") continue;

      const props = (entity as { props?: Record<string, unknown> }).props ?? {};
      const maxTime = props.MaxTime;
      if (maxTime === undefined || maxTime === null) continue;

      const value = String(maxTime);
      if (value === "UNLIMITED") continue;
      if (SLURM_DURATION_RE.test(value)) continue;

      diagnostics.push({
        ruleId: "SLRS001",
        severity: "warning",
        message: `Partition "${name}" MaxTime="${value}" is not a valid Slurm duration — use D-HH:MM:SS or UNLIMITED`,
        entity: name,
        fix: `Use format like "7-00:00:00" for 7 days or "UNLIMITED"`,
      });
    }

    return diagnostics;
  },
};
