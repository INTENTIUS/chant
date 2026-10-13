/**
 * Settings Alertmanager accepts that weaken how it talks to a receiver
 * (PROM220-PROM222): certificate checks turned off, SMTP credentials sent
 * without TLS, and credentials sent to an `http://` URL. `amtool
 * check-config` passes all three.
 */

import type { AlertmanagerGlobalConfig, ReceiverConfig } from "./model";
import type { PrometheusIssue } from "./validate-config";

type Obj = Record<string, unknown>;

function asObj(v: unknown): Obj {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : {};
}

function asList(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

function has(v: unknown): boolean {
  return v !== undefined && v !== null && v !== "";
}

/** Every `tls_config` under `value` with `insecure_skip_verify: true`, by path. */
function insecureTls(value: unknown, path: string): string[] {
  if (Array.isArray(value)) return value.flatMap((v, i) => insecureTls(v, `${path}[${i}]`));
  if (!value || typeof value !== "object") return [];
  const out: string[] = [];
  for (const [key, v] of Object.entries(value as Obj)) {
    const at = path ? `${path}.${key}` : key;
    if (/tls_config$/.test(key) && asObj(v).insecure_skip_verify === true) out.push(at);
    out.push(...insecureTls(v, at));
  }
  return out;
}

/** The fields that carry a destination URL in an integration entry. */
const URL_FIELDS = ["url", "api_url", "webhook_url"];

/** Where an integration takes its URL and credential from `global:` when the entry leaves them out. */
const GLOBAL_FALLBACK: Record<string, { url: string; credentials: string[] }> = {
  pagerduty_configs: { url: "pagerduty_url", credentials: [] },
  opsgenie_configs: { url: "opsgenie_api_url", credentials: ["opsgenie_api_key", "opsgenie_api_key_file"] },
  wechat_configs: { url: "wechat_api_url", credentials: ["wechat_api_secret", "wechat_api_secret_file"] },
  victorops_configs: { url: "victorops_api_url", credentials: ["victorops_api_key", "victorops_api_key_file"] },
  telegram_configs: { url: "telegram_api_url", credentials: ["telegram_bot_token", "telegram_bot_token_file"] },
  webex_configs: { url: "webex_api_url", credentials: [] },
  rocketchat_configs: { url: "rocketchat_api_url", credentials: ["rocketchat_token", "rocketchat_token_file", "rocketchat_token_id", "rocketchat_token_id_file"] },
  jira_configs: { url: "jira_api_url", credentials: [] },
};

/** Entry fields that hold a credential the integration sends with each request. */
const CREDENTIAL_FIELDS = ["api_key", "service_key", "token", "bot_token", "api_secret", "user_key", "token_id", "alert_source_token", "app_token"].flatMap((f) => [
  f,
  `${f}_file`,
]);

/** The credentials an HTTP client config attaches, by name. */
function httpCredentials(http: Obj): string[] {
  const out: string[] = [];
  if (Object.keys(asObj(http.basic_auth)).length > 0) out.push("basic_auth");
  if (Object.keys(asObj(http.authorization)).length > 0) out.push("authorization");
  if (Object.keys(asObj(http.oauth2)).length > 0) out.push("oauth2");
  if (has(http.bearer_token) || has(http.bearer_token_file)) out.push("bearer_token");
  return out;
}

/** PROM220-PROM222 for one receiver. */
export function validateReceiverSecurity(receiver: ReceiverConfig, global: AlertmanagerGlobalConfig): PrometheusIssue[] {
  const issues: PrometheusIssue[] = [];
  const name = String(receiver?.name ?? "");
  const g = asObj(global);
  const rec = receiver as unknown as Obj;

  // PROM220
  for (const at of insecureTls(rec, "")) {
    issues.push({
      code: "PROM220",
      severity: "warning",
      subject: name,
      message: `receiver "${name}" ${at}.insecure_skip_verify is true, so Alertmanager accepts any certificate the endpoint presents`,
    });
  }

  for (const [key, list] of Object.entries(rec)) {
    if (!key.endsWith("_configs")) continue;
    asList(list).forEach((raw, i) => {
      const entry = asObj(raw);
      const at = `receiver "${name}" ${key}[${i}]`;

      // PROM221
      if (key === "email_configs") {
        const requireTls = entry.require_tls ?? g.smtp_require_tls ?? true;
        const auth = ["auth_password", "auth_password_file", "auth_secret", "auth_secret_file"].some((f) => has(entry[f]) || has(g[`smtp_${f}`]));
        if (requireTls === false && auth && entry.force_implicit_tls !== true && g.smtp_force_implicit_tls !== true) {
          issues.push({
            code: "PROM221",
            severity: "warning",
            subject: name,
            message: `${at} sends SMTP credentials with require_tls false${entry.require_tls === undefined ? " (from global.smtp_require_tls)" : ""}, so they can cross the network in clear text`,
          });
        }
        return;
      }

      // PROM222
      const fallback = GLOBAL_FALLBACK[key];
      const urls = URL_FIELDS.filter((f) => typeof entry[f] === "string").map((f) => [f, entry[f] as string] as const);
      if (urls.length === 0 && fallback && typeof g[fallback.url] === "string") urls.push([`global.${fallback.url}`, g[fallback.url] as string]);
      for (const [field, url] of urls) {
        if (!/^http:\/\//i.test(url)) continue;
        const http = entry.http_config !== undefined ? asObj(entry.http_config) : asObj(g.http_config);
        const credentials = [
          ...(/^http:\/\/[^/@]*@/i.test(url) ? ["user info in the URL"] : []),
          ...httpCredentials(http),
          ...CREDENTIAL_FIELDS.filter((f) => has(entry[f])),
          // victorops' routing_key is part of the URL path, not a secret; pagerduty's is the integration key.
          ...(key === "pagerduty_configs" ? ["routing_key", "routing_key_file"].filter((f) => has(entry[f])) : []),
          ...(fallback?.credentials ?? []).filter((f) => has(g[f]) && !CREDENTIAL_FIELDS.some((c) => has(entry[c]))).map((f) => `global.${f}`),
        ];
        if (credentials.length === 0) continue;
        issues.push({
          code: "PROM222",
          severity: "warning",
          subject: name,
          message: `${at} ${field} is http://, and the request carries ${credentials.join(", ")}; use https://`,
        });
      }
    });
  }
  return issues;
}

/** PROM220 for `global:`'s own TLS settings, which every receiver without its own inherits. */
export function validateGlobalSecurity(global: AlertmanagerGlobalConfig): PrometheusIssue[] {
  return insecureTls(asObj(global), "global").map((at) => ({
    code: "PROM220" as const,
    severity: "warning" as const,
    subject: "global",
    message: `${at}.insecure_skip_verify is true, so Alertmanager accepts any certificate a receiver's endpoint presents`,
  }));
}
