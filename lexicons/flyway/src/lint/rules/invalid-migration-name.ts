import type { LintRule, LintDiagnostic, LintContext } from "@intentius/chant/lint/rule";
import * as ts from "typescript";

/**
 * WFW004: Invalid Migration Filename
 *
 * Detects string literals that look like migration filenames but don't follow
 * Flyway's V/R/U naming convention:
 *   - V{version}__{description}.sql  (versioned migration)
 *   - R__{description}.sql           (repeatable migration)
 *   - U{version}__{description}.sql  (undo migration)
 *
 * Bad:  "create_users_table.sql"
 * Good: "V1__create_users_table.sql"
 */
export const invalidMigrationNameRule: LintRule = {
  id: "WFW004",
  severity: "warning",
  category: "correctness",
  description:
    "Detects migration filenames that don't follow V/R/U naming convention",

  check(context: LintContext): LintDiagnostic[] {
    const { sourceFile } = context;
    const diagnostics: LintDiagnostic[] = [];

    const VALID_MIGRATION_PATTERN =
      /^(V[\d.]+__[A-Za-z0-9_]+\.sql|R__[A-Za-z0-9_]+\.sql|U[\d.]+__[A-Za-z0-9_]+\.sql)$/;
    const LOOKS_LIKE_MIGRATION = /\.sql$/i;

    function visit(node: ts.Node): void {
      if (ts.isStringLiteral(node)) {
        const value = node.text;
        if (
          LOOKS_LIKE_MIGRATION.test(value) &&
          !VALID_MIGRATION_PATTERN.test(value)
        ) {
          const { line, character } =
            sourceFile.getLineAndCharacterOfPosition(node.getStart());
          diagnostics.push({
            file: sourceFile.fileName,
            line: line + 1,
            column: character + 1,
            ruleId: "WFW004",
            severity: "warning",
            message: `Migration filename "${value}" does not follow Flyway naming convention (V{version}__{desc}.sql, R__{desc}.sql, or U{version}__{desc}.sql).`,
          });
        }
      }
      ts.forEachChild(node, visit);
    }

    visit(sourceFile);
    return diagnostics;
  },
};
