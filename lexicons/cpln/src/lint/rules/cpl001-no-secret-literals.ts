import ts from "typescript";
import type { LintRule, LintDiagnostic, LintContext } from "@intentius/chant/lint/rule";

/**
 * CPL001: no literal credential material in a cpln declaration.
 *
 * This is a source-level rule rather than a post-synth check on purpose. By
 * the time the manifest exists, a literal is just a string in a `data` block
 * and there is nothing left to point at; here there is a file and a line, which
 * is what makes the finding actionable — and, more to the point, this is the
 * form the credential is in when it enters git history.
 *
 * `Secret` is the obvious carrier, but a credential pasted into a workload's
 * env or an identity's cloud config is the same leak, so the rule fires
 * anywhere inside a `new <cpln kind>(…)`.
 *
 * Complementary to CPL012, which catches the shape this cannot see — a
 * plausible-looking value in a credential-named env var — from the model.
 */

const CPLN_KINDS = new Set(["Gvc", "Workload", "Identity", "VolumeSet", "Secret", "Policy", "Domain", "IpSet"]);

const CREDENTIAL_SHAPES: Array<{ pattern: RegExp; label: string }> = [
  { pattern: /^-----BEGIN [A-Z ]*PRIVATE KEY-----/, label: "private key material" },
  { pattern: /^AKIA[0-9A-Z]{16}$/, label: "AWS access key id" },
  { pattern: /^(ghp|gho|ghs|ghu)_[A-Za-z0-9]{20,}$/, label: "GitHub token" },
  { pattern: /^github_pat_[A-Za-z0-9_]{20,}$/, label: "GitHub fine-grained token" },
  { pattern: /^sk-[A-Za-z0-9_-]{20,}$/, label: "secret API key (sk-)" },
  { pattern: /^xox[baprs]-[A-Za-z0-9-]{10,}$/, label: "Slack token" },
  { pattern: /^ya29\.[A-Za-z0-9_-]{20,}$/, label: "Google OAuth access token" },
  { pattern: /^eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}$/, label: "JWT" },
  {
    pattern: /^postgres(ql)?:\/\/[^:@/\s]+:[^@/\s]+@/,
    label: "database URL with an inline password",
  },
  { pattern: /^mysql:\/\/[^:@/\s]+:[^@/\s]+@/, label: "database URL with an inline password" },
  { pattern: /^mongodb(\+srv)?:\/\/[^:@/\s]+:[^@/\s]+@/, label: "database URL with an inline password" },
];

export const noSecretLiteralsRule: LintRule = {
  id: "CPL001",
  severity: "error",
  category: "security",
  description: "No literal credential material in cpln declarations — reference a secret instead",

  check(context: LintContext): LintDiagnostic[] {
    const diagnostics: LintDiagnostic[] = [];
    const source = context.sourceFile;

    const visit = (node: ts.Node, insideCplnNew: boolean): void => {
      let inside = insideCplnNew;

      if (ts.isNewExpression(node)) {
        const name = node.expression.getText(source);
        const short = name.split(".").pop() ?? name;
        if (CPLN_KINDS.has(short)) inside = true;
      }

      if (inside && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))) {
        for (const { pattern, label } of CREDENTIAL_SHAPES) {
          if (!pattern.test(node.text)) continue;
          const { line, character } = source.getLineAndCharacterOfPosition(node.getStart(source));
          diagnostics.push({
            ruleId: "CPL001",
            severity: "error",
            message:
              `Literal ${label} in a cpln declaration. Store it as a Secret and reference it as ` +
              `\`cpln://secret/NAME.FIELD\` — a literal here is a credential in git history.`,
            file: context.filePath,
            line: line + 1,
            column: character + 1,
          });
          break;
        }
      }

      ts.forEachChild(node, (child) => visit(child, inside));
    };

    visit(source, false);
    return diagnostics;
  },
};
