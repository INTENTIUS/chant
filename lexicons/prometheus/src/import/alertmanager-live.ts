/**
 * Alertmanager's `/api/v2/status` config, back to the shape a person writes
 * (#3371).
 *
 * `config.original` is the loaded config marshalled again, not the file
 * (`Config.String()` in Alertmanager's `config/config.go`). Against
 * Alertmanager v0.34.1 (`PROMETHEUS_PIN.alertmanager`) that adds three
 * kinds of thing a file did not say:
 *
 * - `global:` with every default of `DefaultGlobalConfig()` written out:
 *   `resolve_timeout: 5m`, the default `http_config`, `smtp_hello`,
 *   `smtp_require_tls`, `smtp_tls_config` and the integration API URLs.
 * - every receiver integration with the settings it inherited from `global:`
 *   (`http_config`, an email config's `smarthost`, `from` and SMTP auth, a
 *   Slack config's `api_url`, a PagerDuty config's `url`, and so on), as
 *   `Config.UnmarshalYAML` copies them in.
 * - every integration's own defaults (`DefaultEmailConfig`,
 *   `DefaultSlackConfig`, `DefaultPagerdutyConfig`, ...) and the zero values
 *   of fields marshalled without `omitempty` (`url_file: ""`,
 *   `max_alerts: 0`, `continue: false`).
 *
 * {@link stripAlertmanagerDefaults} takes those out, so an import writes
 * what a person would have declared. It drops a value only where it equals
 * the default or the global it was copied from; a value someone set to the
 * default is indistinguishable from one they left out, and goes too, which
 * builds to the same config. `verbatim` skips it. Secrets read `<secret>`
 * either way (see {@link maskedSecretPaths}).
 */

type Json = Record<string, unknown>;

function isObject(v: unknown): v is Json {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function canonical(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(canonical);
  if (isObject(v)) return Object.fromEntries(Object.keys(v).sort().map((k) => [k, canonical(v[k])]));
  return v;
}

function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
}

/** Empty, false, zero or null: what a field marshalled without `omitempty` holds when nobody set it. */
function isZero(v: unknown): boolean {
  if (v === null || v === undefined || v === "" || v === false || v === 0) return true;
  if (Array.isArray(v)) return v.length === 0;
  if (isObject(v)) return Object.values(v).every(isZero);
  return false;
}

/** `commoncfg.DefaultHTTPClientConfig`, marshalled. */
const DEFAULT_HTTP_CONFIG = { follow_redirects: true, enable_http2: true };

function isDefaultHttpConfig(v: unknown): boolean {
  if (!isObject(v)) return false;
  const rest = Object.fromEntries(Object.entries(v).filter(([k]) => !(k in DEFAULT_HTTP_CONFIG)));
  return Object.entries(DEFAULT_HTTP_CONFIG).every(([k, d]) => v[k] === undefined || v[k] === d) && isZero(rest);
}

/** `DefaultGlobalConfig()` at the pin. `http_config` and `smtp_tls_config` are compared by {@link isDefaultHttpConfig} and {@link isZero}. */
const GLOBAL_DEFAULTS: Json = {
  resolve_timeout: "5m",
  smtp_hello: "localhost",
  smtp_require_tls: true,
  pagerduty_url: "https://events.pagerduty.com/v2/enqueue",
  opsgenie_api_url: "https://api.opsgenie.com/",
  wechat_api_url: "https://qyapi.weixin.qq.com/cgi-bin/",
  victorops_api_url: "https://alert.victorops.com/integrations/generic/20131114/alert/",
  telegram_api_url: "https://api.telegram.org",
  webex_api_url: "https://webexapis.com/v1/messages",
  rocketchat_api_url: "https://open.rocket.chat/",
  slack_app_url: "https://slack.com/api/chat.postMessage",
};

/** Fields `Config.UnmarshalYAML` copies from `global:` into each integration, integration field to global key. */
const INHERITED: Record<string, Record<string, string>> = {
  email_configs: {
    tls_config: "smtp_tls_config",
    smarthost: "smtp_smarthost",
    from: "smtp_from",
    hello: "smtp_hello",
    auth_username: "smtp_auth_username",
    auth_password: "smtp_auth_password",
    auth_password_file: "smtp_auth_password_file",
    auth_secret: "smtp_auth_secret",
    auth_secret_file: "smtp_auth_secret_file",
    auth_identity: "smtp_auth_identity",
    require_tls: "smtp_require_tls",
    force_implicit_tls: "smtp_force_implicit_tls",
  },
  slack_configs: {
    app_url: "slack_app_url",
    app_token: "slack_app_token",
    app_token_file: "slack_app_token_file",
    api_url: "slack_api_url",
    api_url_file: "slack_api_url_file",
  },
  pagerduty_configs: { url: "pagerduty_url" },
  opsgenie_configs: { api_url: "opsgenie_api_url", api_key: "opsgenie_api_key", api_key_file: "opsgenie_api_key_file" },
  wechat_configs: { api_url: "wechat_api_url", api_secret: "wechat_api_secret", api_secret_file: "wechat_api_secret_file", corp_id: "wechat_api_corp_id" },
  victorops_configs: { api_url: "victorops_api_url", api_key: "victorops_api_key", api_key_file: "victorops_api_key_file" },
  telegram_configs: { api_url: "telegram_api_url", bot_token: "telegram_bot_token", bot_token_file: "telegram_bot_token_file" },
  webex_configs: { api_url: "webex_api_url" },
  rocketchat_configs: {
    api_url: "rocketchat_api_url",
    token: "rocketchat_token",
    token_file: "rocketchat_token_file",
    token_id: "rocketchat_token_id",
    token_id_file: "rocketchat_token_id_file",
  },
  mattermost_configs: { webhook_url: "mattermost_webhook_url", webhook_url_file: "mattermost_webhook_url_file" },
  jira_configs: { api_url: "jira_api_url" },
};

/** Each integration's `Default<Kind>Config` at the pin, the fields it sets. Kinds not listed keep what they read. */
const INTEGRATION_DEFAULTS: Record<string, Json> = {
  webhook_configs: { send_resolved: true },
  email_configs: { send_resolved: false, html: '{{ template "email.default.html" . }}' },
  slack_configs: {
    send_resolved: false,
    color: '{{ template "slack.default.color" . }}',
    username: '{{ template "slack.default.username" . }}',
    title: '{{ template "slack.default.title" . }}',
    title_link: '{{ template "slack.default.titlelink" . }}',
    icon_emoji: '{{ template "slack.default.iconemoji" . }}',
    icon_url: '{{ template "slack.default.iconurl" . }}',
    pretext: '{{ template "slack.default.pretext" . }}',
    text: '{{ template "slack.default.text" . }}',
    fallback: '{{ template "slack.default.fallback" . }}',
    callback_id: '{{ template "slack.default.callbackid" . }}',
    footer: '{{ template "slack.default.footer" . }}',
  },
  pagerduty_configs: {
    send_resolved: true,
    description: '{{ template "pagerduty.default.description" .}}',
    client: '{{ template "pagerduty.default.client" . }}',
    client_url: '{{ template "pagerduty.default.clientURL" . }}',
  },
  webex_configs: { send_resolved: true, message: '{{ template "webex.default.message" . }}' },
  rocketchat_configs: {
    send_resolved: false,
    color: '{{ if eq .Status "firing" }}red{{ else }}green{{ end }}',
    emoji: '{{ template "rocketchat.default.emoji" . }}',
    icon_url: '{{ template "rocketchat.default.iconurl" . }}',
    text: '{{ template "rocketchat.default.text" . }}',
    title: '{{ template "rocketchat.default.title" . }}',
    title_link: '{{ template "rocketchat.default.titlelink" . }}',
  },
  wechat_configs: {
    send_resolved: false,
    message: '{{ template "wechat.default.message" . }}',
    to_user: '{{ template "wechat.default.to_user" . }}',
    to_party: '{{ template "wechat.default.to_party" . }}',
    to_tag: '{{ template "wechat.default.to_tag" . }}',
    agent_id: '{{ template "wechat.default.agent_id" . }}',
  },
  victorops_configs: {
    send_resolved: true,
    message_type: "CRITICAL",
    state_message: '{{ template "victorops.default.state_message" . }}',
    entity_display_name: '{{ template "victorops.default.entity_display_name" . }}',
    monitoring_tool: '{{ template "victorops.default.monitoring_tool" . }}',
  },
  pushover_configs: {
    send_resolved: true,
    title: '{{ template "pushover.default.title" . }}',
    message: '{{ template "pushover.default.message" . }}',
    url: '{{ template "pushover.default.url" . }}',
    priority: '{{ if eq .Status "firing" }}2{{ else }}0{{ end }}',
    retry: "1m",
    expire: "1h",
  },
  sns_configs: { send_resolved: true, subject: '{{ template "sns.default.subject" . }}', message: '{{ template "sns.default.message" . }}' },
};

/** `DefaultEmailSubject`, which an email config's `headers` gain when they set no Subject. */
const DEFAULT_EMAIL_SUBJECT = '{{ template "email.default.subject" . }}';

/** `DefaultPagerdutyDetails`, merged into every PagerDuty config's `details`. */
const DEFAULT_PAGERDUTY_DETAILS: Json = {
  firing: "{{ .Alerts.Firing | toJson }}",
  resolved: "{{ .Alerts.Resolved | toJson }}",
  num_firing: "{{ .Alerts.Firing | len }}",
  num_resolved: "{{ .Alerts.Resolved | len }}",
};

function stripIntegration(kind: string, raw: Json, global: Json): Json {
  const out: Json = { ...raw };
  const inherited = INHERITED[kind] ?? {};
  const defaults = INTEGRATION_DEFAULTS[kind] ?? {};
  for (const [field, globalKey] of Object.entries(inherited)) {
    if (field in out && global[globalKey] !== undefined && same(out[field], global[globalKey])) delete out[field];
    else if (field in out && global[globalKey] === undefined && isZero(out[field]) && field !== "require_tls") delete out[field];
  }
  if ("http_config" in out && (global.http_config !== undefined ? same(out.http_config, global.http_config) : isDefaultHttpConfig(out.http_config))) {
    delete out.http_config;
  }
  for (const [field, d] of Object.entries(defaults)) {
    if (field in out && same(out[field], d)) delete out[field];
  }
  if (kind === "email_configs" && isObject(out.headers)) {
    const headers = { ...out.headers };
    if (headers.Subject === DEFAULT_EMAIL_SUBJECT) delete headers.Subject;
    if (Object.keys(headers).length === 0) delete out.headers;
    else out.headers = headers;
  }
  if (kind === "pagerduty_configs" && isObject(out.details)) {
    const details = Object.fromEntries(Object.entries(out.details).filter(([k, v]) => !same(v, DEFAULT_PAGERDUTY_DETAILS[k])));
    if (Object.keys(details).length === 0) delete out.details;
    else out.details = details;
  }
  // What is left at its zero value was marshalled without omitempty. A field with a known default or a global to
  // inherit from survived the comparisons above because it differs (`send_resolved: false` on a webhook,
  // `require_tls: false` under a global `true`), and `send_resolved` of a kind with no known default stays.
  for (const [k, v] of Object.entries(out)) {
    if (k === "send_resolved" || k in defaults) continue;
    if (k in inherited && global[inherited[k]] !== undefined) continue;
    if (isZero(v)) delete out[k];
  }
  return out;
}

function stripRoute(raw: unknown): unknown {
  if (!isObject(raw)) return raw;
  const out: Json = {};
  for (const [k, v] of Object.entries(raw)) {
    if (k === "routes" && Array.isArray(v)) {
      if (v.length > 0) out.routes = v.map(stripRoute);
      continue;
    }
    if (isZero(v)) continue;
    out[k] = v;
  }
  return out;
}

function stripGlobal(raw: Json): Json {
  const out: Json = {};
  for (const [k, v] of Object.entries(raw)) {
    if (k in GLOBAL_DEFAULTS && same(v, GLOBAL_DEFAULTS[k])) continue;
    if (k === "http_config" && isDefaultHttpConfig(v)) continue;
    if (k === "smtp_require_tls" && v === false) {
      out[k] = v;
      continue;
    }
    if (isZero(v)) continue;
    out[k] = v;
  }
  return out;
}

/** The re-marshalled config with what Alertmanager added taken out (see the module comment). Pure; `doc` is not changed. */
export function stripAlertmanagerDefaults(doc: Json): Json {
  const global = isObject(doc.global) ? doc.global : {};
  const out: Json = {};
  for (const [section, value] of Object.entries(doc)) {
    if (section === "global") {
      const g = stripGlobal(global);
      if (Object.keys(g).length > 0) out.global = g;
    } else if (section === "receivers" && Array.isArray(value)) {
      out.receivers = value.map((r) => {
        if (!isObject(r)) return r;
        const receiver: Json = {};
        for (const [k, v] of Object.entries(r)) {
          if (k.endsWith("_configs") && Array.isArray(v)) {
            if (v.length > 0) receiver[k] = v.map((c) => (isObject(c) ? stripIntegration(k, c, global) : c));
          } else if (k === "name" || !isZero(v)) receiver[k] = v;
        }
        return receiver;
      });
    } else if (section === "route") {
      out.route = stripRoute(value);
    } else if (section === "inhibit_rules" && Array.isArray(value)) {
      if (value.length > 0) out.inhibit_rules = value.map((r) => (isObject(r) ? Object.fromEntries(Object.entries(r).filter(([, v]) => !isZero(v))) : r));
    } else if (!isZero(value)) {
      out[section] = value;
    }
  }
  return out;
}

/** The paths that read `<secret>`, the mask Alertmanager writes over every secret it marshals. */
export function maskedSecretPaths(doc: unknown, at = ""): string[] {
  if (doc === "<secret>") return [at];
  if (Array.isArray(doc)) return doc.flatMap((v, i) => maskedSecretPaths(v, `${at}[${i}]`));
  if (isObject(doc)) return Object.entries(doc).flatMap(([k, v]) => maskedSecretPaths(v, at ? `${at}.${k}` : k));
  return [];
}
