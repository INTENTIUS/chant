import * as ts from "typescript";
import type { LintRule, LintDiagnostic, LintContext } from "@intentius/chant/lint/rule";
import { calleeName, constInitializers, literalText, position, propertyName, resolveConst } from "./prom-ast";
import { checkPromql } from "../../promql";

/**
 * PROM002: a rule's `expr`, written as a string literal inside a
 * `RuleGroup`, is not valid PromQL.
 *
 * The same parse runs after the build as PROM104, over every rule in the
 * emitted rule file. This rule reports it in the editor, at the expression,
 * for the literals it can see; an `expr` built at runtime is left to PROM104.
 */
export const promqlLiteralRule: LintRule = {
  id: "PROM002",
  severity: "error",
  category: "correctness",
  description: "A literal PromQL expression in a RuleGroup does not parse",

  check(context: LintContext): LintDiagnostic[] {
    const diagnostics: LintDiagnostic[] = [];
    const source = context.sourceFile;

    const consts = constInitializers(source);
    const scanned = new Set<ts.Node>();

    // Rules lifted into a const (`rules: apiRules`) are followed to it and
    // checked where the group uses them.
    const follow = (value: ts.Expression) => {
      const init = resolveConst(value, consts);
      if (init !== value && !scanned.has(init)) {
        scanned.add(init);
        scan(init);
      }
    };
    const scan = (node: ts.Node) => {
      if (ts.isShorthandPropertyAssignment(node)) follow(node.name);
      if (ts.isPropertyAssignment(node) && ts.isIdentifier(node.initializer)) follow(node.initializer);
      if (ts.isPropertyAssignment(node) && propertyName(node) === "expr") {
        const text = literalText(node.initializer);
        if (text !== undefined) {
          const checked = checkPromql(text);
          if (!checked.ok) {
            diagnostics.push({
              ruleId: "PROM002",
              severity: "error",
              message: `expr is not valid PromQL: ${checked.message}`,
              file: context.filePath,
              ...position(source, node.initializer),
            });
          }
        }
      }
      ts.forEachChild(node, scan);
    };

    const visit = (node: ts.Node) => {
      if (ts.isNewExpression(node) && calleeName(node) === "RuleGroup") {
        const arg = node.arguments?.[0];
        if (arg) scan(arg);
        return;
      }
      ts.forEachChild(node, visit);
    };

    visit(source);
    return diagnostics;
  },
};
