import * as ts from "typescript";
import type { LintRule, LintDiagnostic, LintContext } from "@intentius/chant/lint/rule";

/**
 * AUG001: a traffic level that is a bare quantity.
 *
 * `Profile.traffic` is the string an engine reads to decide what it is being
 * asked, and `packages/core/src/behaviour.ts` is explicit that chant does not
 * parse it, default it or convert it. A level written `"1000"` gives the engine
 * a number with no unit and no percentile, so it either refuses — which is what
 * the contract tells it to do — or picks a meaning, which is worse.
 *
 * The second reason is the one this rule is named for. A figure's whole defence
 * against being read as a bill is that it is `per-hour at a stated level`, and
 * a level that is itself a bare number reads as an amount at a glance. `"1000
 * rps, p99"` cannot be mistaken for money; `"1000"` sitting beside a currency
 * can.
 *
 * Flags a string literal `traffic` that is empty, or that is a number with no
 * word attached, inside a `Profile(...)` construction. A `traffic` elsewhere is
 * someone else's property.
 */
export const trafficLevelShapeRule: LintRule = {
  id: "AUG001",
  severity: "error",
  category: "correctness",
  description: "A Profile's traffic level is empty or a bare quantity with no unit",

  check(context: LintContext): LintDiagnostic[] {
    const diagnostics: LintDiagnostic[] = [];
    const source = context.sourceFile;

    const flag = (node: ts.Node, value: string) => {
      const { line, character } = source.getLineAndCharacterOfPosition(node.getStart(source));
      diagnostics.push({
        ruleId: "AUG001",
        severity: "error",
        message:
          `Profile.traffic is ${value === "" ? "empty" : `"${value}"`} — an engine is handed this ` +
          "verbatim and chant parses none of it, so a bare quantity names no unit and no percentile. " +
          'Write the level the way the answer will be read: "1000 rps, p99", "peak hour, black friday", ' +
          '"steady state".',
        file: context.filePath,
        line: line + 1,
        column: character + 1,
      });
    };

    const trafficLiteral = (obj: ts.ObjectLiteralExpression): ts.StringLiteralLike | undefined => {
      for (const prop of obj.properties) {
        if (
          ts.isPropertyAssignment(prop) &&
          (ts.isIdentifier(prop.name) || ts.isStringLiteral(prop.name)) &&
          prop.name.text === "traffic" &&
          (ts.isStringLiteral(prop.initializer) || ts.isNoSubstitutionTemplateLiteral(prop.initializer))
        ) {
          return prop.initializer;
        }
      }
      return undefined;
    };

    const visit = (node: ts.Node) => {
      if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
        const callee = node.expression;
        const name = ts.isIdentifier(callee) ? callee.text : undefined;
        if (name === "Profile") {
          const [first] = node.arguments ?? [];
          if (first && ts.isObjectLiteralExpression(first)) {
            const literal = trafficLiteral(first);
            if (literal) {
              const value = literal.text.trim();
              if (value === "" || /^[0-9]+(\.[0-9]+)?$/.test(value)) flag(literal, value);
            }
          }
        }
      }
      ts.forEachChild(node, visit);
    };

    visit(source);
    return diagnostics;
  },
};
