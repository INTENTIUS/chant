import * as ts from "typescript";
import type { LintRule, LintContext, LintDiagnostic } from "../rule";

/**
 * EVL005: Block Body in resource() Callback
 *
 * The second argument to resource() must be an arrow function with an
 * expression body: (props) => ({...}). Block bodies are not allowed
 * because the evaluator expects an expression, not statements.
 */

function checkNode(node: ts.Node, context: LintContext, diagnostics: LintDiagnostic[]): void {
  if (
    ts.isCallExpression(node) &&
    ts.isIdentifier(node.expression) &&
    node.expression.text === "resource"
  ) {
    // resource(Type, (props) => ({ ... })) — second arg is the factory
    const factory = node.arguments[1];
    if (factory && ts.isArrowFunction(factory)) {
      if (ts.isBlock(factory.body)) {
        const { line, character } = context.sourceFile.getLineAndCharacterOfPosition(
          factory.body.getStart(context.sourceFile),
        );
        diagnostics.push({
          file: context.filePath,
          line: line + 1,
          column: character + 1,
          ruleId: "EVL005",
          severity: "error",
          message: "Block body in resource() callback — use expression body: (props) => ({...})",
        });
      }
    }
  }

  ts.forEachChild(node, (child) => checkNode(child, context, diagnostics));
}

export const evl005ResourceBlockBodyRule: LintRule = {
  id: "EVL005",
  severity: "error",
  category: "correctness",
  check(context: LintContext): LintDiagnostic[] {
    const diagnostics: LintDiagnostic[] = [];
    checkNode(context.sourceFile, context, diagnostics);
    return diagnostics;
  },
};
