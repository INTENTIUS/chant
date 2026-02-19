import * as ts from "typescript";
import type { LintRule, LintContext, LintDiagnostic } from "../rule";

/**
 * EVL007: Invalid Siblings Access
 *
 * In a Composite factory, resource() callbacks receive a `siblings` parameter.
 * Accessing siblings.key must reference a key that exists in the composite's
 * resource map.
 */

function checkNode(node: ts.Node, context: LintContext, diagnostics: LintDiagnostic[]): void {
  // Look for Composite(...) calls
  if (
    ts.isCallExpression(node) &&
    ts.isIdentifier(node.expression) &&
    node.expression.text === "Composite"
  ) {
    // The factory function is the argument to Composite
    const factoryArg = node.arguments[0];
    if (factoryArg && (ts.isArrowFunction(factoryArg) || ts.isFunctionExpression(factoryArg))) {
      checkCompositeFactory(factoryArg, context, diagnostics);
    }
  }

  ts.forEachChild(node, (child) => checkNode(child, context, diagnostics));
}

function checkCompositeFactory(
  factory: ts.ArrowFunction | ts.FunctionExpression,
  context: LintContext,
  diagnostics: LintDiagnostic[],
): void {
  // The factory body should contain an object literal with resource() calls
  // that define the composite members. Collect the keys.
  const body = factory.body;
  let memberKeys: Set<string> | null = null;

  if (ts.isBlock(body)) {
    // Look for return statement with object literal
    for (const stmt of body.statements) {
      if (ts.isReturnStatement(stmt) && stmt.expression && ts.isObjectLiteralExpression(stmt.expression)) {
        memberKeys = collectObjectKeys(stmt.expression);
      }
    }
  } else if (ts.isParenthesizedExpression(body) && ts.isObjectLiteralExpression(body.expression)) {
    memberKeys = collectObjectKeys(body.expression);
  } else if (ts.isObjectLiteralExpression(body)) {
    memberKeys = collectObjectKeys(body);
  }

  if (!memberKeys || memberKeys.size === 0) return;

  // Now find resource() calls within the factory and check siblings access
  walkForResourceCalls(body, memberKeys, context, diagnostics);
}

function collectObjectKeys(obj: ts.ObjectLiteralExpression): Set<string> {
  const keys = new Set<string>();
  for (const prop of obj.properties) {
    if (ts.isPropertyAssignment(prop) || ts.isShorthandPropertyAssignment(prop)) {
      if (ts.isIdentifier(prop.name!)) {
        keys.add(prop.name!.text);
      } else if (ts.isStringLiteral(prop.name!)) {
        keys.add(prop.name!.text);
      }
    }
  }
  return keys;
}

function walkForResourceCalls(
  node: ts.Node,
  memberKeys: Set<string>,
  context: LintContext,
  diagnostics: LintDiagnostic[],
): void {
  if (
    ts.isCallExpression(node) &&
    ts.isIdentifier(node.expression) &&
    node.expression.text === "resource"
  ) {
    // resource(Type, (props, siblings) => ...)
    const callback = node.arguments[1];
    if (callback && (ts.isArrowFunction(callback) || ts.isFunctionExpression(callback))) {
      const siblingsParam = callback.parameters[1];
      if (siblingsParam && ts.isIdentifier(siblingsParam.name)) {
        const siblingsName = siblingsParam.name.text;
        checkSiblingsAccess(callback.body, siblingsName, memberKeys, context, diagnostics);
      }
    }
  }

  ts.forEachChild(node, (child) =>
    walkForResourceCalls(child, memberKeys, context, diagnostics),
  );
}

function checkSiblingsAccess(
  node: ts.Node,
  siblingsName: string,
  memberKeys: Set<string>,
  context: LintContext,
  diagnostics: LintDiagnostic[],
): void {
  if (ts.isPropertyAccessExpression(node)) {
    if (ts.isIdentifier(node.expression) && node.expression.text === siblingsName) {
      const accessedKey = node.name.text;
      if (!memberKeys.has(accessedKey)) {
        const { line, character } = context.sourceFile.getLineAndCharacterOfPosition(
          node.getStart(context.sourceFile),
        );
        diagnostics.push({
          file: context.filePath,
          line: line + 1,
          column: character + 1,
          ruleId: "EVL007",
          severity: "error",
          message: `Invalid siblings access — "${accessedKey}" is not a member of this composite`,
        });
      }
    }
  }

  ts.forEachChild(node, (child) =>
    checkSiblingsAccess(child, siblingsName, memberKeys, context, diagnostics),
  );
}

export const evl007InvalidSiblingsRule: LintRule = {
  id: "EVL007",
  severity: "error",
  category: "correctness",
  check(context: LintContext): LintDiagnostic[] {
    const diagnostics: LintDiagnostic[] = [];
    checkNode(context.sourceFile, context, diagnostics);
    return diagnostics;
  },
};
