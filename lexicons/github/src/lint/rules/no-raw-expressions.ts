/**
 * GHA008: No Raw Expressions
 *
 * Flags `${{` strings outside valid context paths.
 */

import type { LintRule, LintDiagnostic, LintContext } from "@intentius/chant/lint/rule";
import * as ts from "typescript";

const VALID_CONTEXTS = ["github.", "secrets.", "matrix.", "steps.", "needs.", "inputs.", "env.", "vars.", "runner.", "always()", "failure()", "success()", "cancelled()", "contains(", "startsWith(", "endsWith(", "format(", "join(", "toJSON(", "fromJSON(", "hashFiles("];

export const noRawExpressionsRule: LintRule = {
  id: "GHA008",
  severity: "info",
  category: "style",
  description: "Avoid raw ${{ }} expression strings — use typed Expression helpers",

  check(context: LintContext): LintDiagnostic[] {
    const { sourceFile } = context;
    const diagnostics: LintDiagnostic[] = [];

    function visit(node: ts.Node): void {
      if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
        const text = node.text;
        if (text.includes("${{")) {
          // Extract the expression content
          const match = text.match(/\$\{\{\s*(.+?)\s*\}\}/);
          if (match) {
            const expr = match[1];
            const isValid = VALID_CONTEXTS.some((ctx) => expr.startsWith(ctx));
            if (!isValid) {
              const { line, character } = sourceFile.getLineAndCharacterOfPosition(node.getStart());
              diagnostics.push({
                file: sourceFile.fileName,
                line: line + 1,
                column: character + 1,
                ruleId: "GHA008",
                severity: "info",
                message: `Raw expression "$\{{ ${expr} }}" doesn't match a known context. Use typed Expression helpers.`,
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
