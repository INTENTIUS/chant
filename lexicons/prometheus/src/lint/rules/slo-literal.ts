import * as ts from "typescript";
import type { LintRule, LintDiagnostic, LintContext } from "@intentius/chant/lint/rule";
import { calleeName, literalText, position, propertyName } from "./prom-ast";
import { sliExprProblem } from "../../composites/slo";
import { durationMs, isValidDuration } from "../../duration";

/** A numeric literal, with an optional leading minus, as a number. */
function literalNumber(node: ts.Expression): number | undefined {
  if (ts.isNumericLiteral(node)) return Number(node.text);
  if (ts.isPrefixUnaryExpression(node) && node.operator === ts.SyntaxKind.MinusToken && ts.isNumericLiteral(node.operand)) {
    return -Number(node.operand.text);
  }
  return undefined;
}

function objectProps(node: ts.Expression): Map<string, ts.Expression> {
  const out = new Map<string, ts.Expression>();
  if (!ts.isObjectLiteralExpression(node)) return out;
  for (const p of node.properties) {
    const name = propertyName(p);
    if (name !== undefined && ts.isPropertyAssignment(p)) out.set(name, p.initializer);
  }
  return out;
}

/**
 * PROM003: an `Slo` whose literal objective, window or SLI expression can
 * not build.
 *
 * `Slo()` throws on the same problems when the build runs it; this rule
 * reports them in the editor, at the literal: an objective outside (0, 1),
 * a window that is not a positive Prometheus duration, and an SLI
 * expression without `{{window}}` or that is not PromQL once it is filled
 * in. Values built at runtime are left to the constructor.
 */
export const sloLiteralRule: LintRule = {
  id: "PROM003",
  severity: "error",
  category: "correctness",
  description: "An Slo's literal objective, window or SLI expression is invalid",

  check(context: LintContext): LintDiagnostic[] {
    const diagnostics: LintDiagnostic[] = [];
    const source = context.sourceFile;
    const report = (node: ts.Node, message: string) =>
      diagnostics.push({ ruleId: "PROM003", severity: "error", message, file: context.filePath, ...position(source, node) });

    const visit = (node: ts.Node) => {
      if ((ts.isCallExpression(node) || ts.isNewExpression(node)) && calleeName(node) === "Slo") {
        const arg = node.arguments?.[0];
        if (arg) {
          const props = objectProps(arg);
          const objective = props.get("objective");
          const o = objective ? literalNumber(objective) : undefined;
          if (objective && o !== undefined && !(o > 0 && o < 1)) {
            report(objective, `Slo objective must be strictly between 0 and 1 (e.g. 0.995 for 99.5%), got ${o}`);
          }
          const window = props.get("window");
          const w = window ? literalText(window) : undefined;
          if (window && w !== undefined && (!isValidDuration(w) || durationMs(w) === 0)) {
            report(window, `Slo window must be a positive Prometheus duration (e.g. 28d or 30d), got ${JSON.stringify(w)}`);
          }
          const sli = props.get("sli");
          if (sli) {
            for (const [key, expr] of objectProps(sli)) {
              if (key !== "good" && key !== "errors" && key !== "total") continue;
              const text = literalText(expr);
              if (text === undefined) continue;
              const problem = sliExprProblem(text);
              if (problem) report(expr, `Slo sli.${key} ${problem}`);
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
