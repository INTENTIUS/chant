import * as ts from "typescript";
import type { LintRule, LintDiagnostic, LintContext } from "@intentius/chant/lint/rule";

/**
 * TF101: terraformApply's planFile must reference a preceding terraformPlan step.
 *
 * Applying a plan file chosen by a string means the applied plan can be
 * stale, hand-edited, or simply the wrong one — the entire point of the
 * plan/apply split (review exactly what will change, then apply exactly
 * that) is defeated the moment the path is spelled out in source instead of
 * carried forward from the `terraformPlan` step that produced it.
 *
 * The two builders this rule is written against (`terraformPlan`,
 * `terraformApply`) don't exist yet (#2086 ships them in parallel), so this
 * matches purely on callee identifier name — same posture as
 * `lexicons/k3s/src/lint/rules/token-literal.ts`.
 *
 * Accepts exactly the two authoring forms that produce a genuine step-output
 * reference (`packages/core/src/op/step-output-ref.ts`):
 *   - `stepOutput(<ident>, "planFile")`
 *   - `<ident>.out.planFile`
 * where `<ident>` is bound (`const <ident> = terraformPlan(...)`) in the same
 * file. Flags a string literal, a template literal, or one of the two
 * accepted reference forms pointing at an identifier that resolves to
 * something other than a `terraformPlan` call. When `<ident>` cannot be
 * resolved at all (not declared anywhere in the file), this rule stays
 * silent — the same deliberately shallow "bail rather than guess" posture
 * `validateStepOutputRefs` takes, since the runtime brand on a real
 * `StepOutputRef` is invisible to a source-level AST match.
 */
export const planBeforeApplyRule: LintRule = {
  id: "TF101",
  severity: "error",
  category: "correctness",
  description: "terraformApply's planFile must reference a preceding terraformPlan step",

  check(context: LintContext): LintDiagnostic[] {
    const diagnostics: LintDiagnostic[] = [];
    const source = context.sourceFile;

    /** Identifier name bound to a `terraformPlan(...)` call, to whether it truly is one. */
    const bindings = new Map<string, boolean>();

    const calleeName = (expr: ts.Expression): string | undefined =>
      ts.isIdentifier(expr) ? expr.text : ts.isPropertyAccessExpression(expr) ? expr.name.text : undefined;

    const collectBindings = (node: ts.Node) => {
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
        const init = node.initializer;
        if (ts.isCallExpression(init) || ts.isNewExpression(init)) {
          bindings.set(node.name.text, calleeName(init.expression) === "terraformPlan");
        }
      }
      ts.forEachChild(node, collectBindings);
    };
    collectBindings(source);

    const flag = (node: ts.Node, message: string) => {
      const { line, character } = source.getLineAndCharacterOfPosition(node.getStart(source));
      diagnostics.push({
        ruleId: "TF101",
        severity: "error",
        message,
        file: context.filePath,
        line: line + 1,
        column: character + 1,
      });
    };

    /**
     * `stepOutput(<ident>, "planFile")` or `<ident>.out.planFile`, returning
     * the referenced identifier's name, or `undefined` if `initializer`
     * isn't one of those two shapes.
     */
    const referencedIdent = (initializer: ts.Expression): string | undefined => {
      if (ts.isCallExpression(initializer) && calleeName(initializer.expression) === "stepOutput") {
        const arg = initializer.arguments[0];
        return arg && ts.isIdentifier(arg) ? arg.text : undefined;
      }
      if (
        ts.isPropertyAccessExpression(initializer) &&
        initializer.name.text === "planFile" &&
        ts.isPropertyAccessExpression(initializer.expression) &&
        initializer.expression.name.text === "out" &&
        ts.isIdentifier(initializer.expression.expression)
      ) {
        return initializer.expression.expression.text;
      }
      return undefined;
    };

    const checkPlanFile = (obj: ts.ObjectLiteralExpression) => {
      for (const prop of obj.properties) {
        if (!ts.isPropertyAssignment(prop)) continue;
        const name = ts.isIdentifier(prop.name)
          ? prop.name.text
          : ts.isStringLiteral(prop.name)
            ? prop.name.text
            : undefined;
        if (name !== "planFile") continue;

        const value = prop.initializer;
        if (ts.isStringLiteral(value) || ts.isNoSubstitutionTemplateLiteral(value) || ts.isTemplateExpression(value)) {
          flag(
            value,
            "`planFile` is a literal path in source. Pass the preceding `terraformPlan` step's output " +
              '(`stepOutput(plan, "planFile")` or `plan.out.planFile`), not a hardcoded path.',
          );
          continue;
        }

        const ident = referencedIdent(value);
        if (ident === undefined) continue; // not one of the two accepted forms — out of this rule's reach
        const isPlan = bindings.get(ident);
        if (isPlan === false) {
          flag(
            value,
            `\`planFile\` references "${ident}", which is not bound to a \`terraformPlan(...)\` call. ` +
              "Apply only a plan this Op itself produced.",
          );
        }
        // isPlan === true: paired correctly.
        // isPlan === undefined: `ident` isn't declared anywhere in this file — cannot resolve
        // statically, so stay silent rather than guess.
      }
    };

    const visit = (node: ts.Node) => {
      if (ts.isCallExpression(node) && calleeName(node.expression) === "terraformApply") {
        // The options object may be the first argument (`terraformApply({ planFile })`)
        // or follow a positional one (`terraformApply("app", { planFile })`, the
        // k3s-shaped builder signature); inspect every object-literal argument.
        for (const arg of node.arguments) {
          if (ts.isObjectLiteralExpression(arg)) checkPlanFile(arg);
        }
      }
      ts.forEachChild(node, visit);
    };

    visit(source);
    return diagnostics;
  },
};
