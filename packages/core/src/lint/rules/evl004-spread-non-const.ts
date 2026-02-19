import * as ts from "typescript";
import type { LintRule, LintContext, LintDiagnostic } from "../rule";
import { isInsideCompositeFactory } from "./composite-scope";

/**
 * EVL004: Spread From Non-Const Source
 *
 * Spread expressions ({...x} or [...x]) must reference a const-declared
 * variable, object literal, or property access chain from a const.
 * Spreading from function calls or non-traceable sources is blocked.
 */

function isTraceableToConst(node: ts.Node, sourceFile: ts.SourceFile): boolean {
  // Object or array literals are fine
  if (ts.isObjectLiteralExpression(node) || ts.isArrayLiteralExpression(node)) {
    return true;
  }

  // Property access: follow the chain to the root
  if (ts.isPropertyAccessExpression(node)) {
    return isTraceableToConst(node.expression, sourceFile);
  }

  // Identifier — check if it's a const declaration
  if (ts.isIdentifier(node)) {
    return isConstIdentifier(node, sourceFile);
  }

  // Parenthesized
  if (ts.isParenthesizedExpression(node)) {
    return isTraceableToConst(node.expression, sourceFile);
  }

  // As/satisfies cast
  if (ts.isAsExpression(node) || ts.isSatisfiesExpression(node)) {
    return isTraceableToConst(node.expression, sourceFile);
  }

  return false;
}

function isConstIdentifier(id: ts.Identifier, sourceFile: ts.SourceFile): boolean {
  // Walk all statements looking for a const declaration of this identifier
  for (const stmt of sourceFile.statements) {
    if (ts.isVariableStatement(stmt)) {
      if (stmt.declarationList.flags & ts.NodeFlags.Const) {
        for (const decl of stmt.declarationList.declarations) {
          if (ts.isIdentifier(decl.name) && decl.name.text === id.text) {
            return true;
          }
        }
      }
    }
  }
  return false;
}

function checkNode(node: ts.Node, context: LintContext, diagnostics: LintDiagnostic[]): void {
  // Skip spreads inside Composite() factory callbacks
  if (isInsideCompositeFactory(node)) {
    ts.forEachChild(node, (child) => checkNode(child, context, diagnostics));
    return;
  }

  // Spread in object literal: { ...expr }
  if (ts.isSpreadAssignment(node)) {
    if (!isTraceableToConst(node.expression, context.sourceFile)) {
      const { line, character } = context.sourceFile.getLineAndCharacterOfPosition(
        node.getStart(context.sourceFile),
      );
      diagnostics.push({
        file: context.filePath,
        line: line + 1,
        column: character + 1,
        ruleId: "EVL004",
        severity: "error",
        message: "Spread from non-const source — spread expression must reference a const variable or literal",
      });
    }
  }

  // Spread in array literal: [...expr]
  if (ts.isSpreadElement(node)) {
    if (!isTraceableToConst(node.expression, context.sourceFile)) {
      const { line, character } = context.sourceFile.getLineAndCharacterOfPosition(
        node.getStart(context.sourceFile),
      );
      diagnostics.push({
        file: context.filePath,
        line: line + 1,
        column: character + 1,
        ruleId: "EVL004",
        severity: "error",
        message: "Spread from non-const source — spread expression must reference a const variable or literal",
      });
    }
  }

  ts.forEachChild(node, (child) => checkNode(child, context, diagnostics));
}

export const evl004SpreadNonConstRule: LintRule = {
  id: "EVL004",
  severity: "error",
  category: "correctness",
  check(context: LintContext): LintDiagnostic[] {
    const diagnostics: LintDiagnostic[] = [];
    checkNode(context.sourceFile, context, diagnostics);
    return diagnostics;
  },
};
