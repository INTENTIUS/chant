/**
 * WHM004: HelmTpl Expression Has No Effect in Values Constructor
 *
 * Detects Values constructor props that use `v.xxx` (the `values` proxy)
 * or any HelmTpl-like expression. values.yaml is static YAML — it is NOT
 * processed as a Go template by Helm. These expressions silently become ''.
 *
 * Bad:  new Values({ host: v.pgHost })
 * Good: new Values({ host: runtimeSlot("Cloud SQL private IP") })
 */

import type { LintRule, LintDiagnostic, LintContext } from "@intentius/chant/lint/rule";
import * as ts from "typescript";

export const valuesNoHelmTplRule: LintRule = {
  id: "WHM004",
  severity: "warning",
  category: "correctness",
  description:
    "HelmTpl expression has no effect in values.yaml — use runtimeSlot() for deploy-time values",

  check(context: LintContext): LintDiagnostic[] {
    const { sourceFile } = context;
    const diagnostics: LintDiagnostic[] = [];

    function visit(node: ts.Node): void {
      if (
        ts.isNewExpression(node) &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === "Values" &&
        node.arguments &&
        node.arguments.length > 0
      ) {
        const arg = node.arguments[0];
        if (ts.isObjectLiteralExpression(arg)) {
          checkObjectLiteral(arg, [], sourceFile, diagnostics);
        }
      }
      ts.forEachChild(node, visit);
    }

    visit(sourceFile);
    return diagnostics;
  },
};

/**
 * Get the root identifier name of a property access / call chain.
 * v.foo → "v"; values.x.pipe("fn") → "values"; runtimeSlot() → "runtimeSlot"
 */
function getRootIdentifier(node: ts.Node): string | null {
  if (ts.isIdentifier(node)) return node.text;
  if (ts.isPropertyAccessExpression(node)) return getRootIdentifier(node.expression);
  if (ts.isCallExpression(node)) return getRootIdentifier(node.expression);
  return null;
}

function isHelmTplExpr(node: ts.Node): boolean {
  const root = getRootIdentifier(node);
  return root === "v" || root === "values";
}

function checkObjectLiteral(
  obj: ts.ObjectLiteralExpression,
  path: string[],
  sourceFile: ts.SourceFile,
  diagnostics: LintDiagnostic[],
): void {
  for (const prop of obj.properties) {
    if (!ts.isPropertyAssignment(prop)) continue;

    const keyName = ts.isIdentifier(prop.name) || ts.isStringLiteral(prop.name)
      ? prop.name.text
      : undefined;
    const propPath = keyName ? [...path, keyName] : path;

    if (isHelmTplExpr(prop.initializer)) {
      const { line, character } = sourceFile.getLineAndCharacterOfPosition(prop.getStart());
      const pathStr = propPath.join(".");
      diagnostics.push({
        file: sourceFile.fileName,
        line: line + 1,
        column: character + 1,
        ruleId: "WHM004",
        severity: "warning",
        message: `HelmTpl expression has no effect in values.yaml (values.yaml is not a Go template). Use runtimeSlot() for deploy-time values or a static default.${pathStr ? ` (path: ${pathStr})` : ""}`,
      });
    } else if (ts.isObjectLiteralExpression(prop.initializer)) {
      checkObjectLiteral(prop.initializer, propPath, sourceFile, diagnostics);
    }
  }
}
