import { ts } from "@intentius/chant/lint/typescript";
import type { LintRule, LintDiagnostic, LintContext } from "@intentius/chant/lint/rule";

/**
 * PROW001: a credential written into a job's environment in source.
 *
 * An environment variable whose name says it holds a credential (a token, a
 * password, a secret or a key) with a literal `value` puts that credential
 * in the job config, which is committed and which Deck shows to anyone who
 * can read the job. Read it from a Secret with `valueFrom.secretKeyRef`.
 *
 * Flags an object literal with `name` a string matching the credential
 * words and `value` a non-empty string, the shape of a container's env
 * entry.
 */
export const CREDENTIAL_NAME = /(^|_)(TOKEN|PASSWORD|PASSWD|SECRET|API_?KEY|ACCESS_KEY|PRIVATE_KEY|CREDENTIALS?)(_|$)/i;

export const literalCredentialEnvRule: LintRule = {
  id: "PROW001",
  severity: "error",
  category: "security",
  description: "A job environment variable named as a credential, with a literal value in source",

  check(context: LintContext): LintDiagnostic[] {
    const diagnostics: LintDiagnostic[] = [];
    const source = context.sourceFile;
    const text = (n: ts.Expression): string | undefined =>
      ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n) ? n.text : undefined;

    const visit = (node: ts.Node) => {
      if (ts.isObjectLiteralExpression(node)) {
        let name: string | undefined;
        let value: ts.Expression | undefined;
        for (const p of node.properties) {
          if (!ts.isPropertyAssignment(p) || !(ts.isIdentifier(p.name) || ts.isStringLiteral(p.name))) continue;
          if (p.name.text === "name") name = text(p.initializer);
          if (p.name.text === "value") value = p.initializer;
        }
        const literal = value ? text(value) : undefined;
        if (name && CREDENTIAL_NAME.test(name) && value && literal) {
          const { line, character } = source.getLineAndCharacterOfPosition(value.getStart(source));
          diagnostics.push({
            ruleId: "PROW001",
            severity: "error",
            message: `${name} is set to a literal in source, so the credential is in the job config. Read it from a Secret: valueFrom: { secretKeyRef: { name, key } }.`,
            file: context.filePath,
            line: line + 1,
            column: character + 1,
          });
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
    return diagnostics;
  },
};
