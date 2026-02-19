import * as ts from "typescript";
import type { LintRule, LintContext, LintDiagnostic } from "../rule";

/**
 * EVL003: Dynamic Property Access
 *
 * Computed property access (obj[key]) must use a string or numeric literal key.
 * Dynamic keys (variables, expressions) are not statically evaluable.
 */

function checkNode(node: ts.Node, context: LintContext, diagnostics: LintDiagnostic[]): void {
  if (ts.isElementAccessExpression(node)) {
    const arg = node.argumentExpression;
    if (!ts.isStringLiteral(arg) && !ts.isNumericLiteral(arg)) {
      const { line, character } = context.sourceFile.getLineAndCharacterOfPosition(
        node.getStart(context.sourceFile),
      );
      diagnostics.push({
        file: context.filePath,
        line: line + 1,
        column: character + 1,
        ruleId: "EVL003",
        severity: "error",
        message: "Dynamic property access — computed key must be a string or numeric literal",
      });
    }
  }

  ts.forEachChild(node, (child) => checkNode(child, context, diagnostics));
}

export const evl003DynamicPropertyAccessRule: LintRule = {
  id: "EVL003",
  severity: "error",
  category: "correctness",
  check(context: LintContext): LintDiagnostic[] {
    const diagnostics: LintDiagnostic[] = [];
    checkNode(context.sourceFile, context, diagnostics);
    return diagnostics;
  },
};
