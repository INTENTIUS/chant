import type { LintRule, LintDiagnostic, LintContext } from "@intentius/chant/lint/rule";
import * as ts from "typescript";

/**
 * Property names that carry a credential. Kept conservative on purpose — an
 * inline value under one of these keys is very likely a real secret.
 */
const SECRET_KEY_PATTERN = /(?:^|[_-])(?:password|passwd|secret|token|api[_-]?key|apikey|access[_-]?key|secret[_-]?key|private[_-]?key|client[_-]?secret|credential|auth[_-]?token)(?:$|[_-])/i;

/**
 * Values that are references or placeholders, not literal secrets:
 * shell/interpolation references ($FOO, ${FOO}), and secret-manager style
 * references. These are skipped so a `secrets` reference is never flagged.
 */
const REFERENCE_VALUE_PATTERN = /^(?:\$\{?[A-Za-z0-9_]+\}?|(?:secret|ref|env|vault):\S+)$/;

/**
 * FLY004: No secret literals in machine config
 *
 * Flags secret values written inline in config (e.g. an env value under a
 * credential-looking key). Secrets belong in `secrets` (apply-only) or a
 * reference. The heuristic is conservative: it fires only when the property
 * name looks like a credential AND the value is a plain string literal that is
 * not a reference/placeholder, so a `secrets` reference (an identifier or
 * `$FOO` placeholder) is not flagged.
 */
export const noSecretLiteralsRule: LintRule = {
  id: "FLY004",
  severity: "warning",
  category: "security",
  description: "Secret values must not be written inline — use secrets or a reference",

  check(context: LintContext): LintDiagnostic[] {
    const { sourceFile } = context;
    const diagnostics: LintDiagnostic[] = [];

    function visit(node: ts.Node): void {
      if (ts.isPropertyAssignment(node)) {
        const rawName = node.name.getText(sourceFile).replace(/^["']|["']$/g, "");
        const init = node.initializer;
        const literal =
          ts.isStringLiteral(init) || ts.isNoSubstitutionTemplateLiteral(init) ? init.text : undefined;

        if (
          literal !== undefined &&
          literal.length >= 4 &&
          SECRET_KEY_PATTERN.test(rawName) &&
          !REFERENCE_VALUE_PATTERN.test(literal.trim())
        ) {
          const { line, character } = sourceFile.getLineAndCharacterOfPosition(init.getStart(sourceFile));
          diagnostics.push({
            file: sourceFile.fileName,
            line: line + 1,
            column: character + 1,
            ruleId: "FLY004",
            severity: "warning",
            message: `Possible inline secret under "${rawName}". Move the value to \`secrets\` (apply-only) or use a reference instead of an inline literal.`,
          });
        }
      }
      ts.forEachChild(node, visit);
    }

    visit(sourceFile);
    return diagnostics;
  },
};
