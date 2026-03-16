/**
 * GHA016: Validate Concurrency
 *
 * Flags `new Concurrency({cancelInProgress: true})` without `group`.
 */

import type { LintRule, LintDiagnostic, LintContext } from "@intentius/chant/lint/rule";
import * as ts from "typescript";

export const validateConcurrencyRule: LintRule = {
  id: "GHA016",
  severity: "warning",
  category: "correctness",
  description: "Concurrency with cancel-in-progress should specify a group",

  check(context: LintContext): LintDiagnostic[] {
    const { sourceFile } = context;
    const diagnostics: LintDiagnostic[] = [];

    function visit(node: ts.Node): void {
      if (ts.isNewExpression(node)) {
        let isConcurrency = false;
        if (ts.isIdentifier(node.expression) && node.expression.text === "Concurrency") isConcurrency = true;
        if (ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === "Concurrency") isConcurrency = true;

        if (isConcurrency && node.arguments?.length) {
          const arg = node.arguments[0];
          if (ts.isObjectLiteralExpression(arg)) {
            let hasCancelInProgress = false;
            let hasGroup = false;

            for (const prop of arg.properties) {
              if (ts.isPropertyAssignment(prop) && ts.isIdentifier(prop.name)) {
                if (prop.name.text === "cancelInProgress" || prop.name.text === "cancel-in-progress") {
                  // Check if it's set to true
                  if (prop.initializer.kind === ts.SyntaxKind.TrueKeyword) {
                    hasCancelInProgress = true;
                  }
                }
                if (prop.name.text === "group") {
                  hasGroup = true;
                }
              }
            }

            if (hasCancelInProgress && !hasGroup) {
              const { line, character } = sourceFile.getLineAndCharacterOfPosition(node.getStart());
              diagnostics.push({
                file: sourceFile.fileName,
                line: line + 1,
                column: character + 1,
                ruleId: "GHA016",
                severity: "warning",
                message: "Concurrency with cancel-in-progress should specify a group to avoid cancelling unrelated runs.",
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
