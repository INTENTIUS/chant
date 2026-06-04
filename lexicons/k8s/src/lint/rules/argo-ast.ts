/**
 * Shared AST helpers for the Argo declarative lint rules (ARGO001, ARGO004).
 *
 * The Argo CRDs are constructed like any other k8s resource —
 * `new Application({ metadata, spec })` / `new ApplicationSet({ ... })`. These
 * helpers walk the object-literal first argument so a rule can read a nested
 * property by path without re-implementing the traversal each time.
 */
import * as ts from "typescript";

/**
 * Find the object-literal first argument of every `new <Kind>(...)` expression
 * in the file, where Kind is one of the supplied resource kinds.
 */
export function findResourceLiterals(
  sourceFile: ts.SourceFile,
  kinds: Set<string>,
): Array<{ kind: string; literal: ts.ObjectLiteralExpression; node: ts.NewExpression }> {
  const found: Array<{ kind: string; literal: ts.ObjectLiteralExpression; node: ts.NewExpression }> = [];

  function visit(node: ts.Node): void {
    if (
      ts.isNewExpression(node) &&
      ts.isIdentifier(node.expression) &&
      kinds.has(node.expression.text) &&
      node.arguments &&
      node.arguments.length > 0 &&
      ts.isObjectLiteralExpression(node.arguments[0])
    ) {
      found.push({
        kind: node.expression.text,
        literal: node.arguments[0],
        node,
      });
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return found;
}

/** Read the initializer node for `key` on an object literal, if present. */
export function getProp(
  obj: ts.ObjectLiteralExpression,
  key: string,
): ts.Expression | undefined {
  for (const prop of obj.properties) {
    if (
      ts.isPropertyAssignment(prop) &&
      (ts.isIdentifier(prop.name) || ts.isStringLiteral(prop.name)) &&
      prop.name.text === key
    ) {
      return prop.initializer;
    }
  }
  return undefined;
}

/** Read a nested object literal by walking `path` (each segment an object). */
export function getNestedObject(
  obj: ts.ObjectLiteralExpression,
  path: string[],
): ts.ObjectLiteralExpression | undefined {
  let current: ts.ObjectLiteralExpression | undefined = obj;
  for (const segment of path) {
    if (!current) return undefined;
    const next = getProp(current, segment);
    current = next && ts.isObjectLiteralExpression(next) ? next : undefined;
  }
  return current;
}

/** Read a string-literal property value by path (last segment is the key). */
export function getNestedString(
  obj: ts.ObjectLiteralExpression,
  path: string[],
): string | undefined {
  const key = path[path.length - 1];
  const parent = getNestedObject(obj, path.slice(0, -1));
  if (!parent) return undefined;
  const value = getProp(parent, key);
  return value && ts.isStringLiteral(value) ? value.text : undefined;
}

/** Read a boolean-literal property value by path (last segment is the key). */
export function getNestedBoolean(
  obj: ts.ObjectLiteralExpression,
  path: string[],
): boolean | undefined {
  const key = path[path.length - 1];
  const parent = getNestedObject(obj, path.slice(0, -1));
  if (!parent) return undefined;
  const value = getProp(parent, key);
  if (!value) return undefined;
  if (value.kind === ts.SyntaxKind.TrueKeyword) return true;
  if (value.kind === ts.SyntaxKind.FalseKeyword) return false;
  return undefined;
}

/**
 * True if the literal carries the given annotation key under
 * `metadata.annotations`, regardless of value.
 */
export function hasAnnotation(
  obj: ts.ObjectLiteralExpression,
  annotationKey: string,
): boolean {
  const annotations = getNestedObject(obj, ["metadata", "annotations"]);
  if (!annotations) return false;
  return getProp(annotations, annotationKey) !== undefined;
}

/** Line/column (1-based) for a node, for diagnostics. */
export function lineCol(
  sourceFile: ts.SourceFile,
  node: ts.Node,
): { line: number; column: number } {
  const { line, character } = sourceFile.getLineAndCharacterOfPosition(node.getStart());
  return { line: line + 1, column: character + 1 };
}
