/**
 * GHA003: No Hardcoded Secrets
 *
 * Flags string literals matching GitHub token prefixes.
 */

import type { LintRule, LintDiagnostic, LintContext } from "@intentius/chant/lint/rule";
import * as ts from "typescript";

const TOKEN_PREFIXES = ["ghp_", "ghs_", "ghu_", "ghr_", "gho_", "github_pat_"];

export const noHardcodedSecretsRule: LintRule = {
  id: "GHA003",
  severity: "error",
  category: "security",
  description: "No hardcoded GitHub tokens in source code",

  check(context: LintContext): LintDiagnostic[] {
    const { sourceFile } = context;
    const diagnostics: LintDiagnostic[] = [];

    function visit(node: ts.Node): void {
      if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
        const text = node.text;
        for (const prefix of TOKEN_PREFIXES) {
          if (text.includes(prefix)) {
            const { line, character } = sourceFile.getLineAndCharacterOfPosition(node.getStart());
            diagnostics.push({
              file: sourceFile.fileName,
              line: line + 1,
              column: character + 1,
              ruleId: "GHA003",
              severity: "error",
              message: `Hardcoded GitHub token detected (prefix: ${prefix}). Use secrets() instead.`,
            });
            break;
          }
        }
      }
      ts.forEachChild(node, visit);
    }

    visit(sourceFile);
    return diagnostics;
  },
};
