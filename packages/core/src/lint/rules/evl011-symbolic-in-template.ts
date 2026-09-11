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

/**
 * What this span is, if it is one of the shapes that has no string form — or
 * `undefined` for an ordinary expression.
 *
 * The three kinds a syntactic rule can see, matching what `fold()` refuses
 * (#2397): a resource attribute on an identifier bound by `new` in this file,
 * a nested construction used as a value, and a composite `.step`.
 */
function symbolicSpan(expr: ts.Expression, bound: Set<string>): string | undefined {
  if (ts.isNewExpression(expr)) {
    const name = ts.isIdentifier(expr.expression) ? expr.expression.text : "…";
    return `a nested \`new ${name}\``;
  }
  if (ts.isPropertyAccessExpression(expr)) {
    // `Checkout({}).step` — a call's `.step`, whatever the callee is: the
    // idiom is the shape, and a rule cannot know which callees are composites.
    if (expr.name.text === "step" && ts.isCallExpression(expr.expression)) {
      const callee = ts.isIdentifier(expr.expression.expression) ? expr.expression.expression.text : "…";
      return `the composite step \`${callee}(…).step\``;
    }
    if (ts.isIdentifier(expr.expression) && bound.has(expr.expression.text)) {
      return `\`${expr.expression.text}.${expr.name.text}\` is a resource attribute and`;
    }
  }
  return undefined;
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
      const what = symbolicSpan(expr, bound);
      if (what) {
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
            `${what} has no string form until the build resolves it — a plain template would ` +
            "stringify it as \"[object Object]\". Use the lexicon's own intrinsic, whose interior " +
            "handles these (`Sub`${…}`` for CloudFormation), or move it out of the template.",
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
