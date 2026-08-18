import type { LintRule, LintDiagnostic, LintContext } from "@intentius/chant/lint/rule";
import * as ts from "typescript";

/** One cron field: `*`, a number, a range, a list, or any of those with a `/step`. */
const FIELD = String.raw`(?:\*|\d+(?:-\d+)?)(?:,(?:\*|\d+(?:-\d+)?))*(?:\/\d+)?`;
const CRON_5 = new RegExp(`^${FIELD}(?:\\s+${FIELD}){4}$`);

/** True for a standard five-field cron expression (Render accepts no seconds field or macros). */
export function isValidCronSchedule(s: string): boolean {
  return CRON_5.test(s.trim());
}

/**
 * REN003: Valid cron schedule
 *
 * A CronJob's `schedule` must be a standard five-field cron expression
 * (`minute hour day-of-month month day-of-week`). Render rejects `@hourly`-style
 * macros and six-field (seconds) expressions at create time; catch them at build.
 */
export const validCronScheduleRule: LintRule = {
  id: "REN003",
  severity: "error",
  category: "correctness",
  description: "A cron job schedule must be a five-field cron expression",

  check(context: LintContext): LintDiagnostic[] {
    const { sourceFile } = context;
    const diagnostics: LintDiagnostic[] = [];

    function visit(node: ts.Node): void {
      if (ts.isPropertyAssignment(node) && node.name.getText(sourceFile) === "schedule") {
        const init = node.initializer;
        if (ts.isStringLiteral(init) && !isValidCronSchedule(init.text)) {
          const { line, character } = sourceFile.getLineAndCharacterOfPosition(init.getStart(sourceFile));
          diagnostics.push({
            file: sourceFile.fileName,
            line: line + 1,
            column: character + 1,
            ruleId: "REN003",
            severity: "error",
            message: `Invalid cron schedule "${init.text}". Use five fields, e.g. "0 * * * *" (hourly) or "*/15 * * * *" (every 15 minutes); Render accepts no @macros or seconds field.`,
          });
        }
      }
      ts.forEachChild(node, visit);
    }

    visit(sourceFile);
    return diagnostics;
  },
};
