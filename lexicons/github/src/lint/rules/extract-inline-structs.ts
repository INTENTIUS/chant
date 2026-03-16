/**
 * GHA005: Extract Inline Structs
 *
 * Flags object literal nesting depth > 2 inside resource constructors.
 */

import type { LintRule, LintDiagnostic, LintContext } from "@intentius/chant/lint/rule";
import * as ts from "typescript";

const RESOURCE_NAMES = new Set(["Job", "Workflow", "ReusableWorkflowCallJob"]);
const MAX_DEPTH = 2;

export const extractInlineStructsRule: LintRule = {
  id: "GHA005",
  severity: "info",
  category: "style",
  description: "Extract deeply nested inline objects to named constants",

  check(context: LintContext): LintDiagnostic[] {
    const { sourceFile } = context;
    const diagnostics: LintDiagnostic[] = [];

    function isResourceConstructor(node: ts.NewExpression): boolean {
      if (ts.isIdentifier(node.expression)) return RESOURCE_NAMES.has(node.expression.text);
      if (ts.isPropertyAccessExpression(node.expression)) return RESOURCE_NAMES.has(node.expression.name.text);
      return false;
    }

    function checkDepth(node: ts.ObjectLiteralExpression, depth: number): void {
      if (depth > MAX_DEPTH) {
        const { line, character } = sourceFile.getLineAndCharacterOfPosition(node.getStart());
        diagnostics.push({
          file: sourceFile.fileName,
          line: line + 1,
          column: character + 1,
          ruleId: "GHA005",
          severity: "info",
          message: `Object nesting depth ${depth} exceeds ${MAX_DEPTH}. Consider extracting to a named constant.`,
        });
        return;
      }
      for (const prop of node.properties) {
        if (ts.isPropertyAssignment(prop) && ts.isObjectLiteralExpression(prop.initializer)) {
          checkDepth(prop.initializer, depth + 1);
        }
      }
    }

    function visit(node: ts.Node): void {
      if (ts.isNewExpression(node) && isResourceConstructor(node) && node.arguments?.[0]) {
        const arg = node.arguments[0];
        if (ts.isObjectLiteralExpression(arg)) {
          checkDepth(arg, 1);
        }
      }
      ts.forEachChild(node, visit);
    }

    visit(sourceFile);
    return diagnostics;
  },
};
