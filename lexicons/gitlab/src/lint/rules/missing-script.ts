/**
 * WGL002: Missing script
 *
 * A GitLab CI job must have `script`, `trigger`, or `run` defined.
 * Jobs without any of these will fail pipeline validation.
 */

import type { LintRule, LintDiagnostic, LintContext } from "@intentius/chant/lint/rule";
import * as ts from "typescript";

const VALID_EXECUTION_PROPS = new Set(["script", "trigger", "run"]);

export const missingScriptRule: LintRule = {
  id: "WGL002",
  severity: "error",
  category: "correctness",

  check(context: LintContext): LintDiagnostic[] {
    const { sourceFile } = context;
    const diagnostics: LintDiagnostic[] = [];

    function visit(node: ts.Node): void {
      if (ts.isNewExpression(node)) {
        // Check for `new Job(...)` or `new gl.Job(...)`
        let isJob = false;
        const expression = node.expression;

        if (ts.isIdentifier(expression) && expression.text === "Job") {
          isJob = true;
        } else if (ts.isPropertyAccessExpression(expression) && expression.name.text === "Job") {
          isJob = true;
        }

        if (isJob && node.arguments && node.arguments.length > 0) {
          const props = node.arguments[0];
          if (ts.isObjectLiteralExpression(props)) {
            const hasExecution = props.properties.some((prop) => {
              if (ts.isPropertyAssignment(prop) && ts.isIdentifier(prop.name)) {
                return VALID_EXECUTION_PROPS.has(prop.name.text);
              }
              return false;
            });

            if (!hasExecution) {
              const { line, character } = sourceFile.getLineAndCharacterOfPosition(node.getStart());
              diagnostics.push({
                file: sourceFile.fileName,
                line: line + 1,
                column: character + 1,
                ruleId: "WGL002",
                severity: "error",
                message: 'Job must have "script", "trigger", or "run" defined.',
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
