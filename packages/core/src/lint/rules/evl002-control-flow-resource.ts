import * as ts from "typescript";
import type { LintRule, LintContext, LintDiagnostic } from "../rule";

/**
 * EVL002: Control Flow Wrapping Resources
 *
 * Resource constructors (NewExpression) must not appear inside
 * control flow statements (if, for, while, switch, try, etc.).
 * Resources must be unconditionally declared.
 */

const CONTROL_FLOW_KINDS = new Set([
  ts.SyntaxKind.IfStatement,
  ts.SyntaxKind.ForStatement,
  ts.SyntaxKind.ForInStatement,
  ts.SyntaxKind.ForOfStatement,
  ts.SyntaxKind.WhileStatement,
  ts.SyntaxKind.DoStatement,
  ts.SyntaxKind.SwitchStatement,
  ts.SyntaxKind.TryStatement,
]);

function isInsideControlFlow(node: ts.Node): boolean {
  let current = node.parent;
  while (current) {
    if (CONTROL_FLOW_KINDS.has(current.kind)) return true;
    current = current.parent;
  }
  return false;
}

function checkNode(node: ts.Node, context: LintContext, diagnostics: LintDiagnostic[]): void {
  if (ts.isNewExpression(node)) {
    if (isInsideControlFlow(node)) {
      const { line, character } = context.sourceFile.getLineAndCharacterOfPosition(
        node.getStart(context.sourceFile),
      );
      diagnostics.push({
        file: context.filePath,
        line: line + 1,
        column: character + 1,
        ruleId: "EVL002",
        severity: "error",
        message: "Resource constructor inside control flow — resources must be unconditionally declared",
      });
    }
  }

  ts.forEachChild(node, (child) => checkNode(child, context, diagnostics));
}

export const evl002ControlFlowResourceRule: LintRule = {
  id: "EVL002",
  severity: "error",
  category: "correctness",
  check(context: LintContext): LintDiagnostic[] {
    const diagnostics: LintDiagnostic[] = [];
    checkNode(context.sourceFile, context, diagnostics);
    return diagnostics;
  },
};
