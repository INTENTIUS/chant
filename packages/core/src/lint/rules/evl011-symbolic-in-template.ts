import * as ts from "typescript";
import type { LintRule, LintContext, LintDiagnostic } from "../rule";

/**
 * EVL011: a symbolic reference inside a plain template literal
 *
 * `` `${bucket.arn}-suffix` `` cannot be evaluated to a string. A resource
 * attribute stands for a value the build resolves later, so there is nothing
 * to interpolate yet, and JavaScript's answer — `"[object Object]"` — is
 * wrong on both of chant's paths.
 *
 * This rule is the friendly half of #2349. The unfriendly half already landed:
 * `fold()` refuses the span with a located error and `AttrRef.toString` throws,
 * so the program fails either way. What a rule adds is finding it at lint time
 * with the remedy attached, rather than at build time with a stack.
 *
 * ## Why it is a heuristic, and why that is acceptable here
 *
 * Lint sees syntax, not values. `foo.bar` inside a template is a resource
 * attribute only if `foo` is a resource, which is a fact `fold()` has and this
 * rule does not — so the check is: a property access whose object is a
 * plain identifier bound in this file by `new`. That is the shape #2349 was
 * reported against and the shape a lexicon's own docs show.
 *
 * It therefore misses a reference reached some other way (through a parameter,
 * an array, a helper's return) and does not flag an access on a plain object.
 * Missing a case costs nothing, because `fold()` still refuses it; flagging a
 * plain object would be a false positive on code that works, which is the
 * error worth avoiding. This is the same asymmetry `../../fold/subset.ts`
 * documents for EVL generally, pointed the other way: there EVL may be
 * stricter than fold, here it is deliberately looser.
 */

/** Identifiers bound by `const x = new T(...)` at any depth in this file. */
function resourceBindings(sourceFile: ts.SourceFile): Set<string> {
  const names = new Set<string>();
  const visit = (node: ts.Node): void => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer &&
      ts.isNewExpression(node.initializer)
    ) {
      names.add(node.name.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return names;
}

function checkNode(
  node: ts.Node,
  context: LintContext,
  bound: Set<string>,
  diagnostics: LintDiagnostic[],
): void {
  // Untagged only: a tagged template is the documented remedy, and its
  // interior handles envelopes.
  if (ts.isTemplateExpression(node) && !ts.isTaggedTemplateExpression(node.parent)) {
    for (const span of node.templateSpans) {
      const expr = span.expression;
      if (
        ts.isPropertyAccessExpression(expr) &&
        ts.isIdentifier(expr.expression) &&
        bound.has(expr.expression.text)
      ) {
        const { line, character } = context.sourceFile.getLineAndCharacterOfPosition(
          expr.getStart(context.sourceFile),
        );
        diagnostics.push({
          file: context.filePath,
          line: line + 1,
          column: character + 1,
          ruleId: "EVL011",
          severity: "error",
          message:
            `\`${expr.expression.text}.${expr.name.text}\` is a resource attribute and has no string ` +
            "form until the build resolves it — a plain template would stringify it as " +
            "\"[object Object]\". Use the lexicon's own intrinsic, whose interior handles references " +
            "(`Sub`${…}`` for CloudFormation), or move the reference out of the template.",
        });
      }
    }
  }

  ts.forEachChild(node, (child) => checkNode(child, context, bound, diagnostics));
}

export const evl011SymbolicInTemplateRule: LintRule = {
  id: "EVL011",
  severity: "error",
  category: "correctness",
  description: "A resource attribute cannot be interpolated into a plain template literal",
  check(context: LintContext): LintDiagnostic[] {
    const diagnostics: LintDiagnostic[] = [];
    checkNode(context.sourceFile, context, resourceBindings(context.sourceFile), diagnostics);
    return diagnostics;
  },
};
