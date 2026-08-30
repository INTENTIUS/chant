import type { LintRule, LintDiagnostic, LintContext } from "@intentius/chant/lint/rule";
import * as ts from "typescript";

/**
 * Env-var keys that carry a credential. Kept conservative on purpose — an
 * inline value under one of these keys is very likely a real secret.
 */
const SECRET_KEY_PATTERN = /(?:^|[_-])(?:password|passwd|secret|token|api[_-]?key|apikey|access[_-]?key|secret[_-]?key|private[_-]?key|client[_-]?secret|credential|auth[_-]?token)(?:$|[_-])/i;

/**
 * Values that are references or placeholders, not literal secrets: shell/
 * interpolation references ($FOO, ${FOO}) and secret-manager style references.
 */
const REFERENCE_VALUE_PATTERN = /^(?:\$\{?[A-Za-z0-9_]+\}?|(?:secret|ref|env|vault):\S+)$/;

/**
 * REN002: No secret literals in env vars
 *
 * Flags an `envVars` (or `secretFiles`) entry whose `key` looks like a
 * credential and whose `value` is a plain string literal. Render can generate
 * the value (`generateValue: true`), it can come from an EnvGroup or from
 * another resource's attribute (`db.internalConnectionString`), or from the
 * process environment at build time — anything but a literal in source that
 * ends up in git and in the build output.
 */
export const noSecretLiteralsRule: LintRule = {
  id: "REN002",
  severity: "warning",
  category: "security",
  description: "Secret env-var values must not be written inline — use generateValue, an EnvGroup, or a reference",

  check(context: LintContext): LintDiagnostic[] {
    const { sourceFile } = context;
    const diagnostics: LintDiagnostic[] = [];

    function literalOf(init: ts.Expression): string | undefined {
      return ts.isStringLiteral(init) || ts.isNoSubstitutionTemplateLiteral(init) ? init.text : undefined;
    }

    function visit(node: ts.Node): void {
      // `{ key: "DB_PASSWORD", value: "hunter2" }` — an object literal with a
      // secret-looking `key` and a literal `value`.
      if (ts.isObjectLiteralExpression(node)) {
        let key: string | undefined;
        let valueNode: ts.Expression | undefined;
        for (const prop of node.properties) {
          if (!ts.isPropertyAssignment(prop)) continue;
          const name = prop.name.getText(sourceFile).replace(/^["']|["']$/g, "");
          if (name === "key") key = literalOf(prop.initializer);
          if (name === "value") valueNode = prop.initializer;
        }
        if (key && valueNode) {
          const value = literalOf(valueNode);
          if (value !== undefined && value.length >= 4 && SECRET_KEY_PATTERN.test(key) && !REFERENCE_VALUE_PATTERN.test(value.trim())) {
            const { line, character } = sourceFile.getLineAndCharacterOfPosition(valueNode.getStart(sourceFile));
            diagnostics.push({
              file: sourceFile.fileName,
              line: line + 1,
              column: character + 1,
              ruleId: "REN002",
              severity: "warning",
              message: `Possible inline secret for env var "${key}". Use \`generateValue: true\`, an EnvGroup, a resource attribute (e.g. db.internalConnectionString), or process.env — not a literal.`,
            });
          }
        }
      }
      ts.forEachChild(node, visit);
    }

    visit(sourceFile);
    return diagnostics;
  },
};
