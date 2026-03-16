import type { LintRule, LintDiagnostic, LintContext } from "@intentius/chant/lint/rule";
import * as ts from "typescript";

/**
 * WFW002: Hardcoded JDBC URL
 *
 * Detects string literal JDBC URLs in Environment constructors. Database
 * connection URLs often contain hostnames or credentials and should be
 * parameterized or derived from configuration.
 *
 * Bad:  new Environment({ url: "jdbc:postgresql://localhost:5432/mydb" })
 * Good: new Environment({ url: config.jdbcUrl })
 */
export const hardcodedUrlRule: LintRule = {
  id: "WFW002",
  severity: "warning",
  category: "security",
  description:
    "Detects hardcoded JDBC URLs in Environment constructors — URLs should be parameterized",

  check(context: LintContext): LintDiagnostic[] {
    const { sourceFile } = context;
    const diagnostics: LintDiagnostic[] = [];

    function visit(node: ts.Node): void {
      if (
        ts.isPropertyAssignment(node) &&
        ts.isIdentifier(node.name) &&
        node.name.text === "url" &&
        ts.isStringLiteral(node.initializer)
      ) {
        const value = node.initializer.text;
        if (value.startsWith("jdbc:")) {
          const { line, character } =
            sourceFile.getLineAndCharacterOfPosition(
              node.initializer.getStart(),
            );
          diagnostics.push({
            file: sourceFile.fileName,
            line: line + 1,
            column: character + 1,
            ruleId: "WFW002",
            severity: "warning",
            message: `Hardcoded JDBC URL detected. Use a variable or resolver reference instead.`,
          });
        }
      }
      ts.forEachChild(node, visit);
    }

    visit(sourceFile);
    return diagnostics;
  },
};
