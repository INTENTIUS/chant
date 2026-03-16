import type { LintRule, LintDiagnostic, LintContext } from "@intentius/chant/lint/rule";
import * as ts from "typescript";

/**
 * WFW003: Missing Schemas Property
 *
 * Detects Environment constructors that don't include a `schemas` property.
 * Without explicit schemas, Flyway operates on the default schema only,
 * which may lead to unexpected behavior in multi-schema databases.
 *
 * Bad:  new Environment({ url: dbUrl, user: dbUser })
 * Good: new Environment({ url: dbUrl, user: dbUser, schemas: ["public"] })
 */
export const missingSchemasRule: LintRule = {
  id: "WFW003",
  severity: "warning",
  category: "correctness",
  description:
    "Detects Environment constructors without a schemas property — schemas should be explicitly set",

  check(context: LintContext): LintDiagnostic[] {
    const { sourceFile } = context;
    const diagnostics: LintDiagnostic[] = [];

    function visit(node: ts.Node): void {
      // Look for `new Environment({ ... })` calls
      if (
        ts.isNewExpression(node) &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === "Environment" &&
        node.arguments &&
        node.arguments.length > 0
      ) {
        const firstArg = node.arguments[0];
        if (ts.isObjectLiteralExpression(firstArg)) {
          const hasSchemas = firstArg.properties.some(
            (prop) =>
              ts.isPropertyAssignment(prop) &&
              ts.isIdentifier(prop.name) &&
              prop.name.text === "schemas",
          );

          if (!hasSchemas) {
            const { line, character } =
              sourceFile.getLineAndCharacterOfPosition(node.getStart());
            diagnostics.push({
              file: sourceFile.fileName,
              line: line + 1,
              column: character + 1,
              ruleId: "WFW003",
              severity: "warning",
              message: `Environment constructor is missing a "schemas" property. Explicitly set schemas to avoid unexpected behavior.`,
            });
          }
        }
      }
      ts.forEachChild(node, visit);
    }

    visit(sourceFile);
    return diagnostics;
  },
};
