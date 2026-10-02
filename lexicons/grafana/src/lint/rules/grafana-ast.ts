import * as ts from "typescript";

/** The constructor name of a `new X(...)` or `X(...)` expression, if it is a plain or dotted name. */
export function calleeName(node: ts.CallExpression | ts.NewExpression): string | undefined {
  const callee = node.expression;
  if (ts.isIdentifier(callee)) return callee.text;
  if (ts.isPropertyAccessExpression(callee)) return callee.name.text;
  return undefined;
}

/** A property's key as text, for identifier and string-literal keys. */
export function propertyName(prop: ts.ObjectLiteralElementLike): string | undefined {
  if (!ts.isPropertyAssignment(prop)) return undefined;
  if (ts.isIdentifier(prop.name) || ts.isStringLiteral(prop.name)) return prop.name.text;
  return undefined;
}

/** The text of a string literal or substitution-free template, else undefined. */
export function literalText(node: ts.Expression): string | undefined {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  return undefined;
}

export function position(source: ts.SourceFile, node: ts.Node): { line: number; column: number } {
  const { line, character } = source.getLineAndCharacterOfPosition(node.getStart(source));
  return { line: line + 1, column: character + 1 };
}

/** `const name = <init>` declarations in the file, so a value written as a named const can be followed. */
export function constInitializers(source: ts.SourceFile): Map<string, ts.Expression> {
  const out = new Map<string, ts.Expression>();
  const visit = (node: ts.Node) => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) out.set(node.name.text, node.initializer);
    ts.forEachChild(node, visit);
  };
  visit(source);
  return out;
}

/** Follow an identifier to the object literal it was declared as, when it is one in this file. */
export function resolveObject(node: ts.Expression, consts: Map<string, ts.Expression>, depth = 0): ts.ObjectLiteralExpression | undefined {
  let n: ts.Expression = node;
  while (ts.isAsExpression(n) || ts.isSatisfiesExpression(n) || ts.isParenthesizedExpression(n)) n = n.expression;
  if (ts.isObjectLiteralExpression(n)) return n;
  if (ts.isIdentifier(n) && depth < 5) {
    const init = consts.get(n.text);
    if (init) return resolveObject(init, consts, depth + 1);
  }
  return undefined;
}

/** The first object-literal argument of every `new <Name>(...)` or `<Name>(...)` for the names given. */
export function constructorArgs(
  source: ts.SourceFile,
  names: (name: string) => boolean,
): Array<{ name: string; arg: ts.ObjectLiteralExpression }> {
  const consts = constInitializers(source);
  const out: Array<{ name: string; arg: ts.ObjectLiteralExpression }> = [];
  const visit = (node: ts.Node) => {
    if (ts.isNewExpression(node) || ts.isCallExpression(node)) {
      const name = calleeName(node);
      const first = node.arguments?.[0];
      const arg = first ? resolveObject(first, consts) : undefined;
      if (name && arg && names(name)) out.push({ name, arg });
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return out;
}
