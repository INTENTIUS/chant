import * as ts from "typescript";
import type { LintRule, LintContext, LintDiagnostic } from "../rule";
import { isInsideCompositeFactory } from "./composite-scope";

/**
 * EVL010: No data transformation inside Composite factory
 *
 * Composite factories should only compose resources from props, not transform data.
 * Data transformation (map, filter, reduce, etc.) should happen before passing props.
 *
 * Triggers on: props.items.map(x => new Thing(x))
 * Triggers on: props.list.filter(Boolean)
 * Triggers on: Object.keys(props.env).reduce(...)
 * OK: props.policies (pass-through)
 * OK: [a, b] (array literal)
 */

const TRANSFORM_METHODS = new Set([
  "map",
  "filter",
  "reduce",
  "flatMap",
  "forEach",
  "find",
  "some",
  "every",
  "sort",
  "reverse",
  "splice",
  "slice",
  "concat",
]);

function checkNode(node: ts.Node, context: LintContext, diagnostics: LintDiagnostic[]): void {
  if (
    ts.isCallExpression(node) &&
    ts.isPropertyAccessExpression(node.expression) &&
    isInsideCompositeFactory(node)
  ) {
    const methodName = node.expression.name.text;
    if (TRANSFORM_METHODS.has(methodName)) {
      const { line, character } = context.sourceFile.getLineAndCharacterOfPosition(
        node.expression.name.getStart(context.sourceFile),
      );

      diagnostics.push({
        file: context.filePath,
        line: line + 1,
        column: character + 1,
        ruleId: "EVL010",
        severity: "warning",
        message: `Data transformation .${methodName}() inside Composite factory — transform data before passing it as props`,
      });
    }
  }

  ts.forEachChild(node, (child) => checkNode(child, context, diagnostics));
}

export const evl010CompositeNoTransformRule: LintRule = {
  id: "EVL010",
  severity: "warning",
  category: "style",
  check(context: LintContext): LintDiagnostic[] {
    const diagnostics: LintDiagnostic[] = [];
    checkNode(context.sourceFile, context, diagnostics);
    return diagnostics;
  },
};
