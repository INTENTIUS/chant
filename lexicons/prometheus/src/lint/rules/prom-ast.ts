import * as ts from "typescript";

/** The constructor name of a `new X(...)` or `X(...)` expression, if it is a plain or dotted name. */
export function calleeName(node: ts.CallExpression | ts.NewExpression): string | undefined {
  const callee = node.expression;
  if (ts.isIdentifier(callee)) return callee.text;
  if (ts.isPropertyAccessExpression(callee)) return callee.name.text;
  return undefined;
}

/** The classes whose props hold Alertmanager credentials. */
export const CREDENTIAL_CLASS = /^(Receiver|AlertmanagerSettings)$/;

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

/**
 * Every `const name = <initializer>` in the file, so a rule can follow a
 * value lifted out of a constructor into a named const (the way COR001 asks
 * for it, and the way `chant import` writes it) back to its literal.
 */
export function constInitializers(source: ts.SourceFile): Map<string, ts.Expression> {
  const consts = new Map<string, ts.Expression>();
  const collect = (node: ts.Node) => {
    if (ts.isVariableDeclarationList(node) && node.flags & ts.NodeFlags.Const) {
      for (const d of node.declarations) {
        if (ts.isIdentifier(d.name) && d.initializer) consts.set(d.name.text, d.initializer);
      }
    }
    ts.forEachChild(node, collect);
  };
  collect(source);
  return consts;
}

/** `expr` itself, or the initializer of the const it names (followed through `as` and `satisfies`). */
export function resolveConst(expr: ts.Expression, consts: Map<string, ts.Expression>): ts.Expression {
  let cur = expr;
  for (let hops = 0; hops < 8; hops++) {
    if (ts.isAsExpression(cur) || ts.isSatisfiesExpression(cur) || ts.isParenthesizedExpression(cur)) {
      cur = cur.expression;
      continue;
    }
    if (ts.isIdentifier(cur) && consts.has(cur.text)) {
      cur = consts.get(cur.text)!;
      continue;
    }
    break;
  }
  return cur;
}
