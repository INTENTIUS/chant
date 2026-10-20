/** Helpers the e2b lint rules share: finding `new Template({...})` literals and reporting on them. */

import type { LintDiagnostic } from "@intentius/chant/lint/rule";
import { ts } from "@intentius/chant/lint/typescript";

/** The object literal passed to each `new Template({...})` in the file. */
export function templateLiterals(sourceFile: ts.SourceFile): ts.ObjectLiteralExpression[] {
  const found: ts.ObjectLiteralExpression[] = [];
  function visit(node: ts.Node): void {
    if (ts.isNewExpression(node)) {
      const callee = node.expression;
      const name = ts.isIdentifier(callee) ? callee.text : ts.isPropertyAccessExpression(callee) ? callee.name.text : "";
      const arg = node.arguments?.[0];
      if (name === "Template" && arg && ts.isObjectLiteralExpression(arg)) found.push(arg);
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
  return found;
}

/** The initializer of `key` in an object literal, when it is written there. */
export function property(obj: ts.ObjectLiteralExpression, key: string, sourceFile: ts.SourceFile): ts.Expression | undefined {
  for (const p of obj.properties) {
    if (ts.isPropertyAssignment(p) && p.name.getText(sourceFile) === key) return p.initializer;
  }
  return undefined;
}

/** A numeric literal's value, a negated one included; `undefined` for anything computed. */
export function numberLiteral(expr: ts.Expression): number | undefined {
  if (ts.isNumericLiteral(expr)) return Number(expr.text);
  if (ts.isPrefixUnaryExpression(expr) && expr.operator === ts.SyntaxKind.MinusToken && ts.isNumericLiteral(expr.operand)) {
    return -Number(expr.operand.text);
  }
  return undefined;
}

export function at(sourceFile: ts.SourceFile, node: ts.Node, ruleId: string, severity: LintDiagnostic["severity"], message: string): LintDiagnostic {
  const { line, character } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
  return { file: sourceFile.fileName, line: line + 1, column: character + 1, ruleId, severity, message };
}
