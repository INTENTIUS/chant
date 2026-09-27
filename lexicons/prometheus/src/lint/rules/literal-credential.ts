import * as ts from "typescript";
import type { LintRule, LintDiagnostic, LintContext } from "@intentius/chant/lint/rule";
import { calleeName, CREDENTIAL_CLASS, literalText, position, propertyName } from "./prom-ast";

/**
 * Alertmanager fields that hold a secret, each with a `*_file` sibling that
 * reads it from a mounted file instead.
 */
export const SECRET_FIELDS = new Set([
  "api_url", // slack_configs: the incoming-webhook URL is the credential
  "slack_api_url",
  "routing_key",
  "service_key",
  "auth_password",
  "auth_secret",
  "smtp_auth_password",
  "smtp_auth_secret",
  "password",
  "credentials",
  "bearer_token",
  "client_secret",
]);

/**
 * PROM001: a credential written as a literal in a `Receiver` or
 * `AlertmanagerSettings`.
 *
 * A literal there is a secret in the repository and in the emitted
 * `alertmanager.yml`. Alertmanager does not expand environment variables in
 * its config, so the fix is the field's `*_file` sibling (`api_url_file`,
 * `routing_key_file`, `auth_password_file`, `credentials_file`), pointing at
 * a file mounted from a secret store.
 */
export const literalCredentialRule: LintRule = {
  id: "PROM001",
  severity: "error",
  category: "security",
  description: "Alertmanager credential declared as a literal instead of read from a *_file",

  check(context: LintContext): LintDiagnostic[] {
    const diagnostics: LintDiagnostic[] = [];
    const source = context.sourceFile;

    const scanValue = (key: string | undefined, init: ts.Expression) => {
      if (ts.isObjectLiteralExpression(init)) {
        scan(init);
        return;
      }
      if (ts.isArrayLiteralExpression(init)) {
        for (const el of init.elements) if (ts.isObjectLiteralExpression(el)) scan(el);
        return;
      }
      if (!key || !SECRET_FIELDS.has(key)) return;
      const text = literalText(init);
      if (text === undefined || text === "") return;
      diagnostics.push({
        ruleId: "PROM001",
        severity: "error",
        message: `\`${key}\` is a literal credential; Alertmanager doesn't expand environment variables, so mount the secret and set \`${key}_file\` instead`,
        file: context.filePath,
        ...position(source, init),
      });
    };

    const scan = (obj: ts.ObjectLiteralExpression) => {
      for (const prop of obj.properties) {
        if (!ts.isPropertyAssignment(prop)) continue;
        scanValue(propertyName(prop), prop.initializer);
      }
    };

    const visit = (node: ts.Node) => {
      if (ts.isNewExpression(node) || ts.isCallExpression(node)) {
        const name = calleeName(node);
        const arg = node.arguments?.[0];
        if (name && CREDENTIAL_CLASS.test(name) && arg && ts.isObjectLiteralExpression(arg)) scan(arg);
      }
      ts.forEachChild(node, visit);
    };

    visit(source);
    return diagnostics;
  },
};
