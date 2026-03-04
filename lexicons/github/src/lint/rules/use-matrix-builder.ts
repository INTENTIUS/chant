/**
 * GHA004: Use Matrix Builder
 *
 * Flags inline object literals in `matrix` property. Suggests extracting
 * to a named const for reusability and clarity.
 */

import type { LintRule, LintDiagnostic, LintContext } from "@intentius/chant/lint/rule";
import * as ts from "typescript";

export const useMatrixBuilderRule: LintRule = {
  id: "GHA004",
  severity: "info",
  category: "style",
  description: "Extract inline matrix objects to named constants",

  check(context: LintContext): LintDiagnostic[] {
    const { sourceFile } = context;
    const diagnostics: LintDiagnostic[] = [];

    function visit(node: ts.Node): void {
      if (
        ts.isPropertyAssignment(node) &&
        ts.isIdentifier(node.name) &&
        node.name.text === "matrix" &&
        ts.isObjectLiteralExpression(node.initializer)
      ) {
        const { line, character } = sourceFile.getLineAndCharacterOfPosition(node.getStart());
        diagnostics.push({
          file: sourceFile.fileName,
          line: line + 1,
          column: character + 1,
          ruleId: "GHA004",
          severity: "info",
          message: "Consider extracting inline matrix to a named constant for clarity.",
        });
      }
      ts.forEachChild(node, visit);
    }

    visit(sourceFile);
    return diagnostics;
  },
};
