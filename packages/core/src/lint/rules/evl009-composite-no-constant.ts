import * as ts from "typescript";
import type { LintRule, LintContext, LintDiagnostic } from "../rule";
import { getCompositeFactory } from "./composite-scope";

/**
 * EVL009: No extractable constants inside Composite factory
 *
 * Composite factories should only reference props, sibling members, and barrel refs.
 * Object literals and arrays-of-objects that don't reference any of these are
 * extractable constants that belong in a separate file (e.g. defaults.ts).
 *
 * Triggers on: assumeRolePolicyDocument: { Version: "2012-10-17", Statement: [...] }
 * Triggers on: managedPolicyArns: ["arn:aws:iam::aws:policy/..."]
 * OK: assumeRolePolicyDocument: _.$.lambdaTrustPolicy
 * OK: policies: props.policies
 * OK: role: role.arn
 * OK: action: "lambda:InvokeFunction" (simple string literal — not an object)
 */

/**
 * Check whether any leaf node in the subtree references:
 * - The props parameter identifier
 * - A barrel ref (_.$ or $)
 * - A local variable declared in the composite factory body
 */
function referencesPropsOrMembers(
  node: ts.Node,
  propsName: string,
  localNames: Set<string>,
): boolean {
  if (ts.isIdentifier(node)) {
    // Direct props reference
    if (node.text === propsName) return true;
    // Local variable reference (sibling member)
    if (localNames.has(node.text)) return true;
  }

  // Barrel ref: _.$.something or $.something
  if (ts.isPropertyAccessExpression(node)) {
    if (isBarrelRef(node)) return true;
  }

  let found = false;
  ts.forEachChild(node, (child) => {
    if (!found && referencesPropsOrMembers(child, propsName, localNames)) {
      found = true;
    }
  });
  return found;
}

function isBarrelRef(node: ts.PropertyAccessExpression): boolean {
  // _.$.x or $.x
  const expr = node.expression;
  if (ts.isIdentifier(expr) && expr.text === "$") return true;
  if (ts.isPropertyAccessExpression(expr) && ts.isIdentifier(expr.name) && expr.name.text === "$") {
    return true;
  }
  return false;
}

/**
 * Check if a value is an extractable constant:
 * - Object literal (with any nesting)
 * - Array literal containing object literals
 * Simple primitives (string, number, boolean) are allowed inline.
 */
function isExtractableShape(node: ts.Node): boolean {
  if (ts.isObjectLiteralExpression(node)) return true;
  if (ts.isArrayLiteralExpression(node)) {
    return node.elements.some(
      (el) => ts.isObjectLiteralExpression(el) || ts.isArrayLiteralExpression(el),
    );
  }
  return false;
}

function checkComposite(
  call: ts.CallExpression,
  context: LintContext,
  diagnostics: LintDiagnostic[],
): void {
  const factory = call.arguments[0];
  if (!factory || (!ts.isArrowFunction(factory) && !ts.isFunctionExpression(factory))) return;

  // Get props parameter name
  const propsParam = factory.parameters[0];
  const propsName = propsParam && ts.isIdentifier(propsParam.name) ? propsParam.name.text : "";

  // Collect local variable names declared in the factory body
  const localNames = new Set<string>();
  const body = factory.body;
  if (ts.isBlock(body)) {
    for (const stmt of body.statements) {
      if (ts.isVariableStatement(stmt)) {
        for (const decl of stmt.declarationList.declarations) {
          if (ts.isIdentifier(decl.name)) {
            localNames.add(decl.name.text);
          }
        }
      }
    }
  }

  // Walk all NewExpression nodes inside the factory body
  checkForConstants(body, context, diagnostics, propsName, localNames);
}

function checkForConstants(
  node: ts.Node,
  context: LintContext,
  diagnostics: LintDiagnostic[],
  propsName: string,
  localNames: Set<string>,
): void {
  if (ts.isNewExpression(node) && node.arguments && node.arguments.length > 0) {
    const firstArg = node.arguments[0];
    if (ts.isObjectLiteralExpression(firstArg)) {
      for (const prop of firstArg.properties) {
        if (!ts.isPropertyAssignment(prop)) continue;
        const value = prop.initializer;

        if (isExtractableShape(value) && !referencesPropsOrMembers(value, propsName, localNames)) {
          const propName = ts.isIdentifier(prop.name) || ts.isStringLiteral(prop.name)
            ? (ts.isIdentifier(prop.name) ? prop.name.text : prop.name.text)
            : "<computed>";

          const { line, character } = context.sourceFile.getLineAndCharacterOfPosition(
            value.getStart(context.sourceFile),
          );

          diagnostics.push({
            file: context.filePath,
            line: line + 1,
            column: character + 1,
            ruleId: "EVL009",
            severity: "warning",
            message: `Extractable constant in Composite factory property "${propName}" — move to a separate file and reference via _.$.name`,
          });
        }
      }
    }
  }

  ts.forEachChild(node, (child) =>
    checkForConstants(child, context, diagnostics, propsName, localNames),
  );
}

function checkNode(node: ts.Node, context: LintContext, diagnostics: LintDiagnostic[]): void {
  if (ts.isCallExpression(node)) {
    const factory = getCompositeFactory(node);
    if (factory) {
      checkComposite(node, context, diagnostics);
      return; // Don't recurse further — checkComposite handles it
    }
  }

  ts.forEachChild(node, (child) => checkNode(child, context, diagnostics));
}

export const evl009CompositeNoConstantRule: LintRule = {
  id: "EVL009",
  severity: "warning",
  category: "style",
  check(context: LintContext): LintDiagnostic[] {
    const diagnostics: LintDiagnostic[] = [];
    checkNode(context.sourceFile, context, diagnostics);
    return diagnostics;
  },
};
