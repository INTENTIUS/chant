import * as ts from "typescript";
import type { LintRule, LintContext, LintDiagnostic } from "../rule";
import { isInsideCompositeFactory } from "./composite-scope";
import { checkObjectMember } from "../../fold/subset";

/**
 * EVL001: Non-Literal Expression in Resource Constructor
 *
 * Resource constructor property values must be statically evaluable.
 * Allowed: literals, identifiers, property access, object/array literals,
 * template expressions, binary/unary/conditional, as/satisfies casts.
 * Blocked: function calls, method calls, and other dynamic expressions.
 *
 * This is a *diagnostic* (chant #1024, epic #1019) — it exists to give a
 * friendly, early, precisely-located error before synthesis, over exactly
 * the same subset definition `fold()` (the actual enforcement layer,
 * {@link "../../fold/fold"}) uses to decide what it can reduce. Both import
 * the single classifier in {@link "../../fold/subset"}
 * ({@link checkObjectMember}) so a construct flagged here is exactly a
 * construct `fold()` rejects, and vice versa — see that module's doc
 * comment for the few environment-dependent exceptions (identifier
 * resolution, intrinsic tag registration, spread-source runtime type,
 * `&&`/`||`/`??`/`? :` short-circuit laziness) that can't be unified
 * through shape alone.
 */

function checkNode(node: ts.Node, context: LintContext, diagnostics: LintDiagnostic[]): void {
  // Skip resource constructors inside Composite() factory callbacks
  if (ts.isNewExpression(node) && !isInsideCompositeFactory(node)) {
    if (node.arguments && node.arguments.length > 0) {
      const firstArg = node.arguments[0];
      if (ts.isObjectLiteralExpression(firstArg)) {
        for (const prop of firstArg.properties) {
          // `Checkout({...}).step` — the single-action Composite()-wrapper
          // idiom every lexicon's own docs/examples embed inline inside a
          // Job's `steps:` array — is shape-valid unconditionally (chant
          // #1544 introduced this as an EVL-only opt-in while `fold()`
          // still rejected the shape; chant #1174 closed that divergence by
          // making `fold()` accept it too, so `findSubsetViolation` no
          // longer needs a flag to say so).
          const violation = checkObjectMember(prop, context.intrinsics);
          if (violation) {
            const { line, character } = context.sourceFile.getLineAndCharacterOfPosition(
              violation.node.getStart(context.sourceFile),
            );
            diagnostics.push({
              file: context.filePath,
              line: line + 1,
              column: character + 1,
              ruleId: "EVL001",
              severity: "error",
              message: `Non-literal expression in resource constructor property — value must be statically evaluable`,
            });
          }
        }
      }
    }
  }

  ts.forEachChild(node, (child) => checkNode(child, context, diagnostics));
}

export const evl001NonLiteralExpressionRule: LintRule = {
  id: "EVL001",
  severity: "error",
  category: "correctness",
  description: "Resource constructor property values must be statically evaluable — no function calls",
  check(context: LintContext): LintDiagnostic[] {
    const diagnostics: LintDiagnostic[] = [];
    checkNode(context.sourceFile, context, diagnostics);
    return diagnostics;
  },
};
