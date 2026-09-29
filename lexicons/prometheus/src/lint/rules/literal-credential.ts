import * as ts from "typescript";
import type { LintRule, LintDiagnostic, LintContext } from "@intentius/chant/lint/rule";
import { calleeName, constInitializers, CREDENTIAL_CLASS, literalText, position, propertyName, resolveConst } from "./prom-ast";

/**
 * Alertmanager fields that hold a secret, each with a `*_file` sibling that
 * reads it from a mounted file instead.
 */
export const SECRET_FIELDS = new Set([
  "api_url", // slack_configs only: the incoming-webhook URL is the credential (see SECRET_ONLY_IN)
  "webhook_url", // discord, msteams, msteamsv2 and mattermost
  "app_token",
  "routing_key", // pagerduty (victorops' routing_key names a route, see SECRET_ONLY_IN)
  "service_key",
  "api_key",
  "api_secret",
  "bot_token",
  "token",
  "token_id",
  "user_key",
  "alert_source_token",
  "auth_password",
  "auth_secret",
  "smtp_auth_password",
  "smtp_auth_secret",
  "slack_api_url",
  "slack_app_token",
  "opsgenie_api_key",
  "wechat_api_secret",
  "victorops_api_key",
  "telegram_bot_token",
  "rocketchat_token",
  "rocketchat_token_id",
  "mattermost_webhook_url",
  "password",
  "credentials",
  "bearer_token",
  "client_secret",
]);

/**
 * Fields that are a secret in one integration and plain elsewhere: `api_url`
 * is Slack's webhook credential but only an endpoint for the others, and a
 * VictorOps `routing_key` names a route.
 */
const SECRET_ONLY_IN: Record<string, string> = {
  api_url: "slack_configs",
  routing_key: "pagerduty_configs",
};

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

    const consts = constInitializers(source);
    const scanned = new Set<ts.Node>();

    // A value is followed to the const it names, so a list lifted out of the
    // constructor (`email_configs: heartbeatEmail`) is scanned where it is used.
    // `integration` is the `*_configs` list a value sits in, when that is known.
    const scanValue = (key: string | undefined, value: ts.Expression, integration?: string) => {
      const init = resolveConst(value, consts);
      const within = key?.endsWith("_configs") ? key : integration;
      if (ts.isObjectLiteralExpression(init) || ts.isArrayLiteralExpression(init)) {
        if (scanned.has(init)) return;
        scanned.add(init);
        if (ts.isObjectLiteralExpression(init)) scan(init, within);
        else for (const el of init.elements) scanValue(undefined, el, within);
        return;
      }
      if (!key || !SECRET_FIELDS.has(key)) return;
      const only = SECRET_ONLY_IN[key];
      if (only && integration !== undefined && integration !== only) return;
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

    const scan = (obj: ts.ObjectLiteralExpression, integration?: string) => {
      for (const prop of obj.properties) {
        if (ts.isPropertyAssignment(prop)) scanValue(propertyName(prop), prop.initializer, integration);
        else if (ts.isShorthandPropertyAssignment(prop)) scanValue(prop.name.text, prop.name, integration);
        else if (ts.isSpreadAssignment(prop)) scanValue(undefined, prop.expression, integration);
      }
    };

    const visit = (node: ts.Node) => {
      if (ts.isNewExpression(node) || ts.isCallExpression(node)) {
        const name = calleeName(node);
        const arg = node.arguments?.[0];
        if (name && CREDENTIAL_CLASS.test(name) && arg) scanValue(undefined, arg);
      }
      ts.forEachChild(node, visit);
    };

    visit(source);
    return diagnostics;
  },
};
