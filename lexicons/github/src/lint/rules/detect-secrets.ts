/**
 * GHA020: Detect Secrets
 *
 * Scans string literals for patterns matching known secret formats.
 * Skips strings containing "secrets." (proper usage).
 */

import type { LintRule, LintDiagnostic, LintContext } from "@intentius/chant/lint/rule";
import * as ts from "typescript";
import { secretPatterns } from "./data/secret-patterns";

export const detectSecretsRule: LintRule = {
  id: "GHA020",
  severity: "error",
  category: "security",
  description: "Potential secret detected in source code",

  check(context: LintContext): LintDiagnostic[] {
    const { sourceFile } = context;
    const diagnostics: LintDiagnostic[] = [];

    function visit(node: ts.Node): void {
      if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
        const text = node.text;

        // Skip strings that reference secrets properly
        if (text.includes("secrets.")) {
          ts.forEachChild(node, visit);
          return;
        }

        for (const { pattern, description } of secretPatterns) {
          if (pattern.test(text)) {
            const { line, character } = sourceFile.getLineAndCharacterOfPosition(node.getStart());
            diagnostics.push({
              file: sourceFile.fileName,
              line: line + 1,
              column: character + 1,
              ruleId: "GHA020",
              severity: "error",
              message: `Potential ${description} detected. Use secrets() to reference secrets securely.`,
            });
            break; // One diagnostic per string
          }
        }
      }
      ts.forEachChild(node, visit);
    }

    visit(sourceFile);
    return diagnostics;
  },
};
