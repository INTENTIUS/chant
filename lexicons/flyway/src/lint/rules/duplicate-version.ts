import type { LintRule, LintDiagnostic, LintContext } from "@intentius/chant/lint/rule";
import * as ts from "typescript";

/**
 * WFW005: Duplicate Migration Version
 *
 * Detects duplicate version numbers in migration filename arrays. Flyway
 * requires unique version numbers — duplicate versions cause migration
 * failures at runtime.
 *
 * Bad:  ["V1__create_users.sql", "V1__create_orders.sql"]
 * Good: ["V1__create_users.sql", "V2__create_orders.sql"]
 */
export const duplicateVersionRule: LintRule = {
  id: "WFW005",
  severity: "error",
  category: "correctness",
  description:
    "Detects duplicate version numbers in migration filename arrays",

  check(context: LintContext): LintDiagnostic[] {
    const { sourceFile } = context;
    const diagnostics: LintDiagnostic[] = [];

    const VERSION_PATTERN = /^(V|U)([\d.]+)__/;

    function visit(node: ts.Node): void {
      if (ts.isArrayLiteralExpression(node)) {
        const versionMap = new Map<string, ts.StringLiteral[]>();

        for (const element of node.elements) {
          if (ts.isStringLiteral(element)) {
            const match = element.text.match(VERSION_PATTERN);
            if (match) {
              const versionKey = `${match[1]}${match[2]}`;
              const existing = versionMap.get(versionKey) ?? [];
              existing.push(element);
              versionMap.set(versionKey, existing);
            }
          }
        }

        for (const [version, literals] of versionMap) {
          if (literals.length > 1) {
            for (const literal of literals) {
              const { line, character } =
                sourceFile.getLineAndCharacterOfPosition(literal.getStart());
              diagnostics.push({
                file: sourceFile.fileName,
                line: line + 1,
                column: character + 1,
                ruleId: "WFW005",
                severity: "error",
                message: `Duplicate migration version "${version}" in "${literal.text}". Each version number must be unique.`,
              });
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
