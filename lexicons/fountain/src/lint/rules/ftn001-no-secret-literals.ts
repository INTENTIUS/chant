import ts from "typescript";
import type { LintRule, LintDiagnostic, LintContext } from "@intentius/chant/lint/rule";

/**
 * FTN001: no secret literals in fountain resource declarations.
 *
 * Environment/Vault secrets and MCP server env values must be substitution
 * references (`${VAR}`) or provider references — never literal credential
 * values. A literal in source is a credential in git history.
 *
 * Fires on string literals matching well-known credential shapes anywhere
 * inside a `new Environment/Vault/Agent(...)` expression.
 */

const FOUNTAIN_KINDS = new Set(["Environment", "Vault", "Agent"]);

const CREDENTIAL_SHAPES: Array<{ pattern: RegExp; label: string }> = [
  { pattern: /^AKIA[0-9A-Z]{16}$/, label: "AWS access key id" },
  { pattern: /^(ghp|gho|ghs|ghu)_[A-Za-z0-9]{20,}$/, label: "GitHub token" },
  { pattern: /^github_pat_[A-Za-z0-9_]{20,}$/, label: "GitHub fine-grained token" },
  { pattern: /^sk-[A-Za-z0-9_-]{20,}$/, label: "secret API key (sk-)" },
  { pattern: /^ftn_[A-Za-z0-9]{16,}$/, label: "fountain API key" },
  { pattern: /^xox[baprs]-[A-Za-z0-9-]{10,}$/, label: "Slack token" },
  { pattern: /^-----BEGIN [A-Z ]*PRIVATE KEY-----/, label: "private key material" },
];

export const noSecretLiteralsRule: LintRule = {
  id: "FTN001",
  severity: "error",
  category: "security",
  description:
    "No literal credential values in fountain declarations — use ${VAR} substitution or a secret provider",

  check(context: LintContext): LintDiagnostic[] {
    const diagnostics: LintDiagnostic[] = [];
    const source = context.sourceFile;

    const visit = (node: ts.Node, insideFountainNew: boolean) => {
      let inside = insideFountainNew;

      if (ts.isNewExpression(node)) {
        const name = node.expression.getText(source);
        const short = name.split(".").pop() ?? name;
        if (FOUNTAIN_KINDS.has(short)) inside = true;
      }

      if (inside && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))) {
        const value = node.text;
        for (const { pattern, label } of CREDENTIAL_SHAPES) {
          if (pattern.test(value)) {
            const { line, character } = source.getLineAndCharacterOfPosition(node.getStart(source));
            diagnostics.push({
              ruleId: "FTN001",
              severity: "error",
              message: `Literal ${label} in a fountain declaration — use \${VAR} substitution or a secret provider`,
              file: context.filePath,
              line: line + 1,
              column: character + 1,
            });
            break;
          }
        }
      }

      ts.forEachChild(node, (child) => visit(child, inside));
    };

    visit(source, false);
    return diagnostics;
  },
};
