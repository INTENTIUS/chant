/**
 * The contact point settings Grafana stores encrypted, per integration: the
 * options marked `secure` by `GET /api/alert-notifiers?version=2` on
 * `grafana/grafana:13.2.2` (commit 1bea008f; the same list on 12.4.11).
 * Nested settings are dotted paths (`tlsConfig.clientKey`).
 *
 * GRAF002 flags a literal at one of these paths, and the importer replaces
 * the `[REDACTED]` that an export without secrets writes there.
 */
export const CONTACT_POINT_SECRET_SETTINGS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  dingding: ["url"],
  discord: ["url"],
  email: [],
  googlechat: ["url"],
  jira: ["user", "password", "api_token"],
  kafka: ["password"],
  line: ["token"],
  mqtt: ["password", "tlsConfig.caCertificate", "tlsConfig.clientCertificate", "tlsConfig.clientKey"],
  oncall: ["password", "authorization_credentials"],
  opsgenie: ["apiKey"],
  pagerduty: ["integrationKey"],
  "prometheus-alertmanager": ["basicAuthPassword"],
  pushover: ["apiToken", "userKey"],
  sensugo: ["apikey"],
  slack: ["token", "url"],
  sns: ["sigv4.access_key", "sigv4.secret_key"],
  teams: [],
  telegram: ["bottoken"],
  threema: ["api_secret"],
  victorops: ["url"],
  webex: ["bot_token"],
  webhook: [
    "password",
    "authorization_credentials",
    "tlsConfig.caCertificate",
    "tlsConfig.clientCertificate",
    "tlsConfig.clientKey",
    "hmacConfig.secret",
    "http_config.oauth2.client_secret",
    "http_config.oauth2.tls_config.caCertificate",
    "http_config.oauth2.tls_config.clientCertificate",
    "http_config.oauth2.tls_config.clientKey",
  ],
  wechat: ["api_secret", "http_config.basic_auth.password", "http_config.authorization.credentials", "http_config.oauth2.client_secret"],
  wecom: ["url", "secret"],
});

/** How Grafana provisioning reads a value from outside the file: `$VAR`, `${VAR}`, `$__env{…}`, `$__file{…}`, `$__vault{…}`. */
export const EXPANDED_VALUE = /\$(\{[A-Za-z_][A-Za-z0-9_]*\}|[A-Za-z_][A-Za-z0-9_]*|__(env|file|vault)\{[^}]+\})/;

/** What an export without secrets writes in place of each one. */
export const REDACTED = "[REDACTED]";

/** The secret settings of one receiver present in `settings`, with their values: `[path, value]`. */
export function secretSettings(type: string, settings: Record<string, unknown>): Array<[string, unknown]> {
  const out: Array<[string, unknown]> = [];
  for (const path of CONTACT_POINT_SECRET_SETTINGS[type] ?? []) {
    let node: unknown = settings;
    for (const seg of path.split(".")) node = node && typeof node === "object" ? (node as Record<string, unknown>)[seg] : undefined;
    if (node !== undefined) out.push([path, node]);
  }
  return out;
}
