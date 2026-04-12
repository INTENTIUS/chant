/**
 * TMP002: TemporalSchedule AllowAll overlap without explanatory note
 *
 * AllowAll allows any number of concurrent schedule runs. This is safe for
 * idempotent, read-only workflows, but can cause resource exhaustion or
 * duplicate side-effects if not explicitly intended. Requiring a note forces
 * the author to document the intent.
 */

import type { LintRule, LintDiagnostic, LintContext } from "@intentius/chant/lint/rule";

export const tmp002: LintRule = {
  id: "TMP002",
  severity: "warning",
  category: "best-practices",
  description: "TemporalSchedule with overlap AllowAll should include state.note explaining the intent",

  check(context: LintContext): LintDiagnostic[] {
    const diagnostics: LintDiagnostic[] = [];

    for (const [name, entity] of context.entities) {
      const et = (entity as Record<string, unknown>).entityType as string;
      if (et !== "Temporal::Schedule") continue;

      const props = (entity as { props?: Record<string, unknown> }).props ?? {};
      const policies = props.policies as Record<string, unknown> | undefined;
      if (policies?.overlap !== "AllowAll") continue;

      const state = props.state as Record<string, unknown> | undefined;
      const note = state?.note as string | undefined;

      if (!note || note.trim() === "") {
        diagnostics.push({
          ruleId: "TMP002",
          severity: "warning",
          message: `Schedule "${name}" uses overlap "AllowAll" — add state.note explaining why concurrent runs are safe`,
          entity: name,
          fix: 'Add state: { note: "Workflow is idempotent — concurrent runs are safe" }',
        });
      }
    }

    return diagnostics;
  },
};
