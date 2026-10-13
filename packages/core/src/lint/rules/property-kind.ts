import * as ts from "typescript";
import type { LintContext } from "../rule";

/**
 * Property-kind declarables for the COR001, COR004 and COR009 heuristics
 * (chant #2957).
 *
 * Those three rules were written for cloud resources, where every `new X(…)`
 * is something the build emits. A property-kind declarable (`createProperty`)
 * is not: it only exists inside the resource that holds it, like a Grafana
 * panel inside its dashboard. The active lexicons name their property-kind
 * classes through `LexiconPlugin.propertyClassNames()`, and `runLint` puts
 * them on `LintContext.propertyClasses`. Without that set (a unit test, or a
 * lexicon that declares none) nothing is property-kind and the rules behave
 * as they always have.
 */

/**
 * Map each locally bound import name to the name it was exported under, so
 * `import { TimeSeriesPanel as Series }` still resolves `new Series(…)`.
 */
function importAliases(sourceFile: ts.SourceFile): Map<string, string> {
  const aliases = new Map<string, string>();
  for (const stmt of sourceFile.statements) {
    if (!ts.isImportDeclaration(stmt)) continue;
    const bindings = stmt.importClause?.namedBindings;
    if (!bindings || !ts.isNamedImports(bindings)) continue;
    for (const el of bindings.elements) {
      if (el.propertyName) aliases.set(el.name.text, el.propertyName.text);
    }
  }
  return aliases;
}

const aliasCache = new WeakMap<ts.SourceFile, Map<string, string>>();

/** The exported class name a `new` expression constructs, if it has one. */
export function constructedClassName(node: ts.NewExpression, sourceFile: ts.SourceFile): string | undefined {
  const expr = node.expression;
  if (ts.isPropertyAccessExpression(expr)) return expr.name.text;
  if (!ts.isIdentifier(expr)) return undefined;
  let aliases = aliasCache.get(sourceFile);
  if (!aliases) {
    aliases = importAliases(sourceFile);
    aliasCache.set(sourceFile, aliases);
  }
  return aliases.get(expr.text) ?? expr.text;
}

/** True when `node` constructs a class an active lexicon declares property-kind. */
export function isPropertyKindNew(node: ts.NewExpression, context: LintContext): boolean {
  const classes = context.propertyClasses;
  if (!classes || classes.size === 0) return false;
  const name = constructedClassName(node, context.sourceFile);
  return name !== undefined && classes.has(name);
}
