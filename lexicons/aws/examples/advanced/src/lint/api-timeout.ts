import type { LintRule, LintDiagnostic, LintContext } from "@intentius/chant/lint/rule";
import * as ts from "typescript";

const API_FACTORIES = new Set(["LambdaApi", "SecureApi", "HighMemoryApi"]);

/**
 * WAW012: API Gateway Lambda Timeout
 *
 * Detects Lambda API composites with timeout > 29 seconds.
 * API Gateway has a maximum synchronous timeout of 29 seconds, so Lambda functions
 * behind it should not exceed this limit.
 */
export const apiTimeoutRule: LintRule = {
  id: "WAW012",
  severity: "error",
  category: "correctness",

  check(context: LintContext): LintDiagnostic[] {
    const { sourceFile } = context;
    const diagnostics: LintDiagnostic[] = [];

    function visit(node: ts.Node): void {
      // Look for `LambdaApi(...)`, `SecureApi(...)`, `HighMemoryApi(...)` calls
      if (ts.isCallExpression(node)) {
        const expression = node.expression;
        let isApiFactory = false;

        if (ts.isIdentifier(expression) && API_FACTORIES.has(expression.text)) {
          isApiFactory = true;
        }

        if (isApiFactory && node.arguments && node.arguments.length > 0) {
          const props = node.arguments[0];
          if (ts.isObjectLiteralExpression(props)) {
            for (const prop of props.properties) {
              if (ts.isPropertyAssignment(prop) && ts.isIdentifier(prop.name)) {
                if (prop.name.text === "timeout") {
                  if (ts.isNumericLiteral(prop.initializer)) {
                    const timeout = Number.parseInt(prop.initializer.text, 10);
                    if (timeout > 29) {
                      const { line, character } = sourceFile.getLineAndCharacterOfPosition(
                        prop.getStart()
                      );
                      diagnostics.push({
                        file: sourceFile.fileName,
                        line: line + 1,
                        column: character + 1,
                        ruleId: "WAW012",
                        severity: "error",
                        message: `Lambda function timeout (${timeout}s) exceeds API Gateway's maximum synchronous timeout of 29 seconds. Reduce timeout to 29 or less.`,
                      });
                    }
                  }
                }
              }
            }
          }
        }
      }

      ts.forEachChild(node, visit);
    }

    visit(sourceFile);
    return diagnostics;
  },
};
