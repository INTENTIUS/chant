/**
 * CEDC001: a Cedar policy declaration must have a usable effect and no empty guard
 *
 * Two authoring mistakes that the serializer cannot report and the emitted
 * artifact hides:
 *
 * - **An effect that is not `permit` or `forbid`.** Cedar has exactly two, and
 *   the serializer coerces anything that is not the literal string `"forbid"`
 *   into `permit`. So `effect: "deny"` — the word every other policy language
 *   in the world uses, and the one a reader will reach for — silently emits a
 *   *grant*. There is no downstream stage that can catch this: by the time the
 *   policy set exists, the mistake looks like a deliberate permit.
 * - **An empty `when`/`unless` entry.** `when: ["", "context.mfa"]` emits
 *   `when {  }`, which is not a Cedar expression; the policy set then fails to
 *   parse and the error arrives as a byte offset into a generated file. The
 *   typo is here, in the source, and so is the line number worth printing.
 *
 * Source-level because both are visible only before serialization, and both
 * are about a literal the author typed. A guard built from a variable or a
 * template expression is out of reach of an AST rule and is left alone —
 * CEDC011 covers the emitted form.
 *
 * Scoped by import: only calls to bindings imported from this lexicon are
 * considered, so an unrelated `{ effect: "deny" }` in a file that has nothing
 * to do with Cedar is never flagged.
 */
import type { LintRule, LintDiagnostic, LintContext } from "@intentius/chant/lint/rule";
import * as ts from "typescript";

/** Module specifiers whose exports construct Cedar declarables. */
const CEDAR_MODULE = /chant-lexicon-cedar/;

/** The two effects Cedar has. */
export const CEDAR_EFFECTS = ["permit", "forbid"] as const;

function importedCedarBindings(sourceFile: ts.SourceFile): Set<string> {
  const names = new Set<string>();
  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement)) continue;
    if (!ts.isStringLiteral(statement.moduleSpecifier)) continue;
    if (!CEDAR_MODULE.test(statement.moduleSpecifier.text)) continue;

    const bindings = statement.importClause?.namedBindings;
    if (bindings && ts.isNamedImports(bindings)) {
      for (const element of bindings.elements) names.add(element.name.text);
    }
    if (statement.importClause?.name) names.add(statement.importClause.name.text);
  }
  return names;
}

/** The callee identifier of a `new X(…)` / `X(…)` expression, if it has one. */
function calleeName(node: ts.CallExpression | ts.NewExpression): string | undefined {
  return ts.isIdentifier(node.expression) ? node.expression.text : undefined;
}

/** The last object-literal argument — where chant resources carry their props. */
function propsLiteral(node: ts.CallExpression | ts.NewExpression): ts.ObjectLiteralExpression | undefined {
  const args = [...(node.arguments ?? [])];
  for (let i = args.length - 1; i >= 0; i--) {
    const arg = args[i];
    if (ts.isObjectLiteralExpression(arg)) return arg;
  }
  return undefined;
}

function property(obj: ts.ObjectLiteralExpression, key: string): ts.PropertyAssignment | undefined {
  for (const prop of obj.properties) {
    if (!ts.isPropertyAssignment(prop)) continue;
    if (!ts.isIdentifier(prop.name) && !ts.isStringLiteral(prop.name)) continue;
    if (prop.name.text === key) return prop;
  }
  return undefined;
}

function lineCol(sourceFile: ts.SourceFile, node: ts.Node): { line: number; column: number } {
  const { line, character } = sourceFile.getLineAndCharacterOfPosition(node.getStart());
  return { line: line + 1, column: character + 1 };
}

export const cedarPolicyShapeRule: LintRule = {
  id: "CEDC001",
  severity: "error",
  category: "correctness",
  description:
    "A Cedar policy declaration must use effect permit or forbid, and must not carry an empty when/unless clause",

  check(context: LintContext): LintDiagnostic[] {
    const { sourceFile } = context;
    const diagnostics: LintDiagnostic[] = [];
    const cedarBindings = importedCedarBindings(sourceFile);
    if (cedarBindings.size === 0) return diagnostics;

    const report = (node: ts.Node, message: string): void => {
      const { line, column } = lineCol(sourceFile, node);
      diagnostics.push({
        file: sourceFile.fileName,
        line,
        column,
        ruleId: "CEDC001",
        severity: "error",
        message,
      });
    };

    function inspect(node: ts.CallExpression | ts.NewExpression): void {
      const callee = calleeName(node);
      if (!callee || !cedarBindings.has(callee)) return;
      const props = propsLiteral(node);
      if (!props) return;

      const effect = property(props, "effect");
      if (effect && ts.isStringLiteral(effect.initializer)) {
        const value = effect.initializer.text;
        if (!(CEDAR_EFFECTS as readonly string[]).includes(value)) {
          report(
            effect,
            `Cedar policy effect "${value}" is not a Cedar effect — the language has only permit and forbid, and anything that is not "forbid" is emitted as a permit. Write effect: "forbid" if that is what was meant.`,
          );
        }
      }

      for (const clause of ["when", "unless"] as const) {
        const guard = property(props, clause);
        if (!guard) continue;
        const entries = ts.isArrayLiteralExpression(guard.initializer)
          ? guard.initializer.elements
          : [guard.initializer];
        for (const entry of entries) {
          if (!ts.isStringLiteral(entry) && !ts.isNoSubstitutionTemplateLiteral(entry)) continue;
          if (entry.text.trim() !== "") continue;
          report(
            entry,
            `Cedar policy has an empty ${clause} clause. An empty guard serializes to ${clause} {  }, which is not a Cedar expression and makes the whole policy set unparseable — write the condition, or drop the entry.`,
          );
        }
      }
    }

    function visit(node: ts.Node): void {
      if (ts.isCallExpression(node) || ts.isNewExpression(node)) inspect(node);
      ts.forEachChild(node, visit);
    }

    visit(sourceFile);
    return diagnostics;
  },
};
