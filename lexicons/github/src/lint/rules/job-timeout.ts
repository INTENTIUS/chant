/**
 * GHA014: Job Timeout
 *
 * Flags `new Job({...})` without `timeoutMinutes` property.
 */

import type { LintRule, LintDiagnostic, LintContext } from "@intentius/chant/lint/rule";
import * as ts from "typescript";

export const jobTimeoutRule: LintRule = {
  id: "GHA014",
  severity: "warning",
  category: "correctness",
  description: "Job should specify a timeout-minutes value",

  check(context: LintContext): LintDiagnostic[] {
    const { sourceFile } = context;
    const diagnostics: LintDiagnostic[] = [];

    function visit(node: ts.Node): void {
      if (ts.isNewExpression(node)) {
        let isJob = false;
        if (ts.isIdentifier(node.expression) && node.expression.text === "Job") isJob = true;
        if (ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === "Job") isJob = true;

        if (isJob && node.arguments?.length) {
          const arg = node.arguments[0];
          if (ts.isObjectLiteralExpression(arg)) {
            const hasTimeout = arg.properties.some((prop) => {
              if (ts.isPropertyAssignment(prop)) {
                const name = ts.isIdentifier(prop.name) ? prop.name.text
                  : ts.isStringLiteral(prop.name) ? prop.name.text
                  : "";
                return name === "timeoutMinutes" || name === "timeout-minutes";
              }
              return false;
            });

            if (!hasTimeout) {
              const { line, character } = sourceFile.getLineAndCharacterOfPosition(node.getStart());
              diagnostics.push({
                file: sourceFile.fileName,
                line: line + 1,
                column: character + 1,
                ruleId: "GHA014",
                severity: "warning",
                message: "Job should specify timeoutMinutes. Default is 360 (6 hours), which may be excessive.",
              });
            }
          }
        }
      }
      ts.forEachChild(node, visit);
    }

    visit(sourceFile);
    return diagnostics;
  },
};
