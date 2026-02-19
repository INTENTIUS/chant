import * as ts from "typescript";
import type { LintRule, LintContext, LintDiagnostic } from "../rule";

/**
 * COR003: no-string-ref
 *
 * Flag string-based `GetAtt("name", "attr")` and `Ref("name")` intrinsic
 * calls. These bypass type safety — users should import resources and use
 * typed AttrRef properties like `resource.arn`.
 */

const TARGET_FUNCTIONS = new Set(["GetAtt", "Ref"]);

export const noStringRefRule: LintRule = {
  id: "COR003",
  severity: "warning",
  category: "correctness",
  check(context: LintContext): LintDiagnostic[] {
    const diagnostics: LintDiagnostic[] = [];
    const sf = context.sourceFile;

    function visit(node: ts.Node): void {
      if (ts.isCallExpression(node)) {
        const name = getCalledFunctionName(node);
        if (name && TARGET_FUNCTIONS.has(name) && hasStringArguments(node)) {
          const { line, character } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
          const fnText = name === "GetAtt" ? "GetAtt" : "Ref";
          diagnostics.push({
            file: context.filePath,
            line: line + 1,
            column: character + 1,
            ruleId: "COR003",
            severity: "warning",
            message: `Avoid string-based ${fnText}() — import the resource and use typed property access instead.`,
          });
        }
      }
      ts.forEachChild(node, visit);
    }

    visit(sf);
    return diagnostics;
  },
};

/**
 * Extract the function name from a call expression.
 * Handles both `GetAtt(...)` and `aws.GetAtt(...)` patterns.
 */
function getCalledFunctionName(node: ts.CallExpression): string | undefined {
  const expr = node.expression;
  if (ts.isIdentifier(expr)) {
    return expr.text;
  }
  if (ts.isPropertyAccessExpression(expr) && ts.isIdentifier(expr.name)) {
    return expr.name.text;
  }
  return undefined;
}

/**
 * Check if the call has at least one string literal argument.
 */
function hasStringArguments(node: ts.CallExpression): boolean {
  return node.arguments.some((arg) => ts.isStringLiteral(arg));
}
