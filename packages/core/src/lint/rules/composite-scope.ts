import * as ts from "typescript";

/**
 * Check if a node is inside a Composite() factory callback.
 *
 * Composite factories define parameterized resource groups where dynamic
 * expressions, spreads, and inline objects are expected. Lint rules that
 * enforce static declarations should skip nodes inside these callbacks.
 *
 * Matches: Composite((props) => { ... }) and _.Composite((props) => { ... })
 */
export function isInsideCompositeFactory(node: ts.Node): boolean {
  let current: ts.Node | undefined = node.parent;

  while (current) {
    if (ts.isArrowFunction(current) || ts.isFunctionExpression(current)) {
      const parent = current.parent;
      if (parent && ts.isCallExpression(parent) && parent.arguments[0] === current) {
        const callee = parent.expression;
        if (isCompositeCallee(callee)) {
          return true;
        }
      }
    }
    current = current.parent;
  }

  return false;
}

/**
 * If the given CallExpression is a Composite() call, return its factory argument.
 * Returns undefined if not a Composite call or factory is missing.
 */
export function getCompositeFactory(
  call: ts.CallExpression,
): ts.ArrowFunction | ts.FunctionExpression | undefined {
  if (!isCompositeCallee(call.expression)) return undefined;
  const factory = call.arguments[0];
  if (!factory) return undefined;
  if (ts.isArrowFunction(factory) || ts.isFunctionExpression(factory)) return factory;
  return undefined;
}

export function isCompositeCallee(node: ts.Expression): boolean {
  // Composite(...)
  if (ts.isIdentifier(node) && node.text === "Composite") {
    return true;
  }
  // _.Composite(...) or anything.Composite(...)
  if (ts.isPropertyAccessExpression(node) && node.name.text === "Composite") {
    return true;
  }
  return false;
}
