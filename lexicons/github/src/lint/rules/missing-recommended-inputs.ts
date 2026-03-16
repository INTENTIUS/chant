/**
 * GHA010: Missing Recommended Inputs
 *
 * Flags setup action composites without version-related inputs.
 */

import type { LintRule, LintDiagnostic, LintContext } from "@intentius/chant/lint/rule";
import * as ts from "typescript";
import { recommendedInputs } from "./data/recommended-inputs";

const SETUP_ACTIONS = new Set(Object.keys(recommendedInputs));

export const missingRecommendedInputsRule: LintRule = {
  id: "GHA010",
  severity: "warning",
  category: "correctness",
  description: "Setup action composite should specify a version input",

  check(context: LintContext): LintDiagnostic[] {
    const { sourceFile } = context;
    const diagnostics: LintDiagnostic[] = [];

    function visit(node: ts.Node): void {
      // Match: SetupNode({...}), SetupGo({...}), SetupPython({...})
      if (ts.isCallExpression(node)) {
        let actionName: string | null = null;

        if (ts.isIdentifier(node.expression) && SETUP_ACTIONS.has(node.expression.text)) {
          actionName = node.expression.text;
        }

        if (actionName && node.arguments.length > 0) {
          const arg = node.arguments[0];
          if (ts.isObjectLiteralExpression(arg)) {
            const required = recommendedInputs[actionName] ?? [];
            const propNames = arg.properties
              .filter(ts.isPropertyAssignment)
              .map((p) => (ts.isIdentifier(p.name) ? p.name.text : ""));

            const hasAny = required.some((r) => propNames.includes(r));
            if (!hasAny) {
              const { line, character } = sourceFile.getLineAndCharacterOfPosition(node.getStart());
              diagnostics.push({
                file: sourceFile.fileName,
                line: line + 1,
                column: character + 1,
                ruleId: "GHA010",
                severity: "warning",
                message: `${actionName}() should specify a version input (${required.join(" or ")}).`,
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
