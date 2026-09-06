import ts from "typescript";
import type { LintRule, LintDiagnostic, LintContext } from "@intentius/chant/lint/rule";

/**
 * FTN001: no secret literals in fountain resource declarations or config.
 *
 * Environment/Vault secrets and MCP server env values must be substitution
 * references (`${VAR}`) or provider references — never literal credential
 * values. A literal in source is a credential in git history.
 *
 * Fires on:
 * - a string literal matching a well-known credential shape anywhere inside
 *   a `new Environment/Vault/Agent(...)` expression;
 * - a `token` property whose value is a plain string literal anywhere inside
 *   `fountain.profiles` in `chant.config.ts` — a profile's `token` is always
 *   `{ env: "VAR_NAME" }`, never a literal, regardless of whether the literal
 *   happens to match one of the known credential shapes.
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

/** Text of a property's name, whether written as an identifier or a quoted string. */
function propertyKeyText(node: ts.PropertyAssignment): string | undefined {
  if (ts.isIdentifier(node.name) || ts.isStringLiteral(node.name)) return node.name.text;
  return undefined;
}

interface VisitState {
  /** Inside `new Environment/Vault/Agent(...)` — the original FTN001 scope. */
  insideFountainNew: boolean;
  /** Inside the `fountain` property of a config object. */
  insideFountainKey: boolean;
  /** Inside the `profiles` property of `fountain`. */
  insideProfilesKey: boolean;
}

export const noSecretLiteralsRule: LintRule = {
  id: "FTN001",
  severity: "error",
  category: "security",
  description:
    "No literal credential values in fountain declarations, and no literal token under fountain.profiles — use ${VAR} substitution, { env } or a secret provider",

  check(context: LintContext): LintDiagnostic[] {
    const diagnostics: LintDiagnostic[] = [];
    const source = context.sourceFile;

    const report = (node: ts.Node, message: string) => {
      const { line, character } = source.getLineAndCharacterOfPosition(node.getStart(source));
      diagnostics.push({
        ruleId: "FTN001",
        severity: "error",
        message,
        file: context.filePath,
        line: line + 1,
        column: character + 1,
      });
    };

    const visit = (node: ts.Node, state: VisitState) => {
      let { insideFountainNew, insideFountainKey, insideProfilesKey } = state;

      if (ts.isNewExpression(node)) {
        const name = node.expression.getText(source);
        const short = name.split(".").pop() ?? name;
        if (FOUNTAIN_KINDS.has(short)) insideFountainNew = true;
      }

      if (ts.isPropertyAssignment(node)) {
        const key = propertyKeyText(node);
        if (key === "fountain") {
          insideFountainKey = true;
          insideProfilesKey = false;
        } else if (insideFountainKey && key === "profiles") {
          insideProfilesKey = true;
        }

        // A profile's `token` must be `{ env: "VAR_NAME" }`, never a literal —
        // no exception for a value that doesn't happen to match a known
        // credential shape, since a profile's whole purpose is to never carry
        // one.
        if (
          insideFountainKey &&
          insideProfilesKey &&
          key === "token" &&
          (ts.isStringLiteral(node.initializer) || ts.isNoSubstitutionTemplateLiteral(node.initializer))
        ) {
          report(
            node.initializer,
            'Literal token under fountain.profiles — use { env: "VAR_NAME" } to name an environment variable instead',
          );
        }
      }

      if (
        insideFountainNew &&
        (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))
      ) {
        const value = node.text;
        for (const { pattern, label } of CREDENTIAL_SHAPES) {
          if (pattern.test(value)) {
            report(node, `Literal ${label} in a fountain declaration — use \${VAR} substitution or a secret provider`);
            break;
          }
        }
      }

      ts.forEachChild(node, (child) =>
        visit(child, { insideFountainNew, insideFountainKey, insideProfilesKey }),
      );
    };

    visit(source, { insideFountainNew: false, insideFountainKey: false, insideProfilesKey: false });
    return diagnostics;
  },
};
