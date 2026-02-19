/**
 * WGL003: Missing stage
 *
 * Jobs should declare a `stage` property. Without it, the job defaults
 * to the "test" stage which may not be the intended behavior.
 */

import type { LintRule, LintDiagnostic, LintContext } from "@intentius/chant/lint/rule";
import * as ts from "typescript";

export const missingStageRule: LintRule = {
  id: "WGL003",
  severity: "info",
  category: "style",

  check(context: LintContext): LintDiagnostic[] {
    const { sourceFile } = context;
    const diagnostics: LintDiagnostic[] = [];

    function visit(node: ts.Node): void {
      if (ts.isNewExpression(node)) {
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
            const hasStage = props.properties.some((prop) => {
              if (ts.isPropertyAssignment(prop) && ts.isIdentifier(prop.name)) {
                return prop.name.text === "stage";
              }
              return false;
            });

            if (!hasStage) {
              const { line, character } = sourceFile.getLineAndCharacterOfPosition(node.getStart());
              diagnostics.push({
                file: sourceFile.fileName,
                line: line + 1,
                column: character + 1,
                ruleId: "WGL003",
                severity: "info",
                message: 'Job does not declare a "stage". It will default to "test".',
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
