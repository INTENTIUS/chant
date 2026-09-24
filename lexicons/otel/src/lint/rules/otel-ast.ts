import * as ts from "typescript";

/** The constructor name of a `new X(...)` or `X(...)` expression, if it is a plain or dotted name. */
export function calleeName(node: ts.CallExpression | ts.NewExpression): string | undefined {
  const callee = node.expression;
  if (ts.isIdentifier(callee)) return callee.text;
  if (ts.isPropertyAccessExpression(callee)) return callee.name.text;
  return undefined;
}

/** Built-in and custom collector component classes follow this naming, e.g. `OtlpExporter`. */
export const COMPONENT_CLASS = /(Receiver|Processor|Exporter|Extension)$/;

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
