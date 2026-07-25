import * as ts from "typescript";
import type { LintRule, LintContext, LintDiagnostic } from "../rule";
import { isLiteralElementKey } from "../../fold/subset";

/**
 * EVL003: Dynamic Property Access
 *
 * Computed property access (obj[key]) must use a string or numeric literal key.
 * Dynamic keys (variables, expressions) are not statically evaluable.
 *
 * Shares its key-shape predicate with `fold()`'s `elementKey()`
 * ({@link "../../fold/fold"}) via {@link "../../fold/subset"} (#1024) — a
 * dynamic element-access key is exactly the construct `fold()` rejects with
 * `FoldError.ruleId === "EVL003"`, and the diagnostic is located at the key
 * itself (not the whole `obj[key]` access), matching where `fold()`'s
 * `elementKey()` throws — so a rejection and its EVL003 diagnostic cite the
 * same position, not just the same rule id.
 */

function checkNode(node: ts.Node, context: LintContext, diagnostics: LintDiagnostic[]): void {
  if (ts.isElementAccessExpression(node)) {
    const arg = node.argumentExpression;
    if (!isLiteralElementKey(arg)) {
      const { line, character } = context.sourceFile.getLineAndCharacterOfPosition(
        arg.getStart(context.sourceFile),
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
  description: "Computed property access must use a string or numeric literal key",
  check(context: LintContext): LintDiagnostic[] {
    const diagnostics: LintDiagnostic[] = [];
    checkNode(context.sourceFile, context, diagnostics);
    return diagnostics;
  },
};
