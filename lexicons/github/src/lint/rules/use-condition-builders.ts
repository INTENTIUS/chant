/**
 * GHA002: Use Condition Builders
 *
 * Flags string literals containing `${{` in `if` property assignments
 * inside Job/Step constructors. Suggests using Expression helpers.
 */

import type { LintRule, LintDiagnostic, LintContext } from "@intentius/chant/lint/rule";
import * as ts from "typescript";

export const useConditionBuildersRule: LintRule = {
  id: "GHA002",
  severity: "warning",
  category: "style",
  description: "Use Expression helpers instead of raw ${{ }} strings in if conditions",

  check(context: LintContext): LintDiagnostic[] {
    const { sourceFile } = context;
    const diagnostics: LintDiagnostic[] = [];

    function visit(node: ts.Node): void {
      if (
        ts.isPropertyAssignment(node) &&
        ts.isIdentifier(node.name) &&
        node.name.text === "if" &&
        ts.isStringLiteral(node.initializer) &&
        node.initializer.text.includes("${{")
      ) {
        const { line, character } = sourceFile.getLineAndCharacterOfPosition(node.getStart());
        diagnostics.push({
          file: sourceFile.fileName,
          line: line + 1,
          column: character + 1,
          ruleId: "GHA002",
          severity: "warning",
          message: "Use typed Expression helpers (e.g., github.ref.eq('refs/heads/main')) instead of raw ${{ }} strings.",
        });
      }
      ts.forEachChild(node, visit);
    }

    visit(sourceFile);
    return diagnostics;
  },
};
