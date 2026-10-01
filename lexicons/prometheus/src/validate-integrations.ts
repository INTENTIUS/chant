/**
 * Receiver integration and `global:` checks for `alertmanager.yml`
 * (PROM208-PROM210), one case per validation Alertmanager v0.34.1 makes when
 * it loads the file (see ./pin.ts). Sources, under
 * github.com/prometheus/alertmanager at that tag:
 *
 * - `config/notifiers.go`: the `UnmarshalYAML` of the Email, Slack (and its
 *   fields, actions and confirmations), WeChat, VictorOps, Pushover, SNS,
 *   Rocket.Chat and Webex configs.
 * - `notify/<name>/config.go`: the `UnmarshalYAML` of the Discord,
 *   incident.io, Jira, Mattermost (and its fields), MS Teams, MS Teams v2,
 *   Opsgenie, PagerDuty, Telegram and webhook configs.
 * - `config/config.go`: `Config.UnmarshalYAML`, which fills each
 *   integration from its `global:` default and then rejects what is still
 *   missing, and the `global:` "at most one of" checks; `HostPort` for
 *   `smarthost`.
 *
 * Durations come in two grammars. `model.Duration` fields (`resolve_timeout`,
 * the route timers, Jira `reopen_duration`) use Prometheus's, see
 * ./duration.ts. `time.Duration` fields (the `timeout` of webhook, Slack,
 * PagerDuty and incident.io, and Pushover's `retry`, `expire` and `ttl`)
 * use Go's `time.ParseDuration`: `1.5s` and `300ms` are valid, `1d` is not.
 *
 * Alertmanager stops at the first error; these checks report every one.
 * PROM209 is something missing (a destination, credential or required
 * field), PROM210 a setting Alertmanager rejects (two settings that exclude
 * each other, or a value outside the allowed set), PROM208 a duration.
 */

import { isValidDuration } from "./duration";
import type { AlertmanagerGlobalConfig, HttpClientConfig, ReceiverConfig } from "./model";
import type { PrometheusIssue } from "./validate-config";

type Obj = Record<string, unknown>;
type Code = "PROM208" | "PROM209" | "PROM210";

function str(v: unknown): string {
  return typeof v === "string" ? v : String(v);
}

/** Set, as Go sees a string field: absent, null and "" all read as unset. */
function has(v: unknown): boolean {
  return v !== undefined && v !== null && v !== "";
}

function asObj(v: unknown): Obj {
  return v && typeof v === "object" ? (v as Obj) : {};
}

function asList(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

const GO_DURATION = /^[-+]?(?:(?:\d+\.?\d*|\.\d+)(?:ns|us|µs|μs|ms|s|m|h))+$/;

/** True when `value` is a Go `time.ParseDuration` duration (`0`, `1.5s`, `1h30m`, `300ms`). */
export function isValidGoDuration(value: unknown): boolean {
  if (value === 0) return true;
  if (typeof value !== "string") return false;
  if (/^[-+]?0$/.test(value)) return true;
  return GO_DURATION.test(value);
}

/**
 * Whether an `http_config` carries an `Authorization` header once
 * prometheus/common has read it: `bearer_token(_file)` becomes one.
 */
function hasAuthorization(http: unknown): boolean {
  const h = asObj(http) as HttpClientConfig;
  return h.authorization !== undefined && h.authorization !== null ? true : has(h.bearer_token) || has(h.bearer_token_file);
}

/** `host:port`, as Go's `net.SplitHostPort` reads it, with a non-empty port. */
function isHostPort(v: unknown): boolean {
  if (typeof v !== "string") return false;
  const m = /^(?:\[[^\]]*\]|[^:[\]]*):([^:[\]]*)$/.exec(v);
  return m !== null && m[1] !== "";
}

const SLACK_APP_URL = "https://slack.com/api/chat.postMessage";

class Reporter {
  readonly issues: PrometheusIssue[] = [];
  constructor(private readonly subject: string, private readonly prefix: string) {}
  add(code: Code, message: string): void {
    this.issues.push({ code, severity: "error", subject: this.subject, message: `${this.prefix}${message}` });
  }
  /** PROM210 when both a value and its `_file` sibling are set. */
  oneOf(c: Obj, at: string, a: string, b = `${a}_file`): void {
    if (has(c[a]) && has(c[b])) this.add("PROM210", `${at} sets both ${a} and ${b}; set at most one`);
  }
  goDuration(c: Obj, at: string, field: string): void {
    const v = c[field];
    if (v !== undefined && v !== null && !isValidGoDuration(v)) {
      this.add("PROM208", `${at}.${field} "${str(v)}" is not a Go duration (e.g. 10s, 1m30s, 500ms)`);
    }
  }
  promDuration(c: Obj, at: string, field: string): void {
    const v = c[field];
    if (v !== undefined && v !== null && !isValidDuration(v)) {
      this.add("PROM208", `${at}.${field} "${str(v)}" is not a duration (e.g. 30m, 4h, 1d)`);
    }
  }
}

type IntegrationCheck = (c: Obj, at: string, g: Obj, r: Reporter) => void;

/** Webhook, Discord, MS Teams and MS Teams v2: a URL or its file, not both. */
function urlOrFile(field: string): IntegrationCheck {
  return (c, at, _g, r) => {
    if (!has(c[field]) && !has(c[`${field}_file`])) r.add("PROM209", `${at} has no ${field} or ${field}_file`);
    r.oneOf(c, at, field);
  };
}

/** Title and value on each field of a Slack or Mattermost message. */
function titledFields(c: Obj, at: string, r: Reporter): void {
  asList(c.fields).forEach((f, j) => {
    const field = asObj(f);
    if (!has(field.title)) r.add("PROM210", `${at}.fields[${j}] has no title`);
    if (!has(field.value)) r.add("PROM210", `${at}.fields[${j}] has no value`);
  });
}

const OPSGENIE_RESPONDER_TYPES = ["team", "teams", "user", "escalation", "schedule"];
const VICTOROPS_RESERVED = ["routing_key", "message_type", "state_message", "entity_display_name", "monitoring_tool", "entity_id", "entity_state"];
const TELEGRAM_PARSE_MODES = ["Markdown", "MarkdownV2", "HTML"];
const JIRA_API_TYPES = ["auto", "cloud", "datacenter"];

/** Go's `textproto.CanonicalMIMEHeaderKey`, enough to compare header names. */
function canonicalHeader(name: string): string {
  return name
    .split("-")
    .map((p) => (p ? p[0].toUpperCase() + p.slice(1).toLowerCase() : p))
    .join("-");
}

const CHECKS: Record<string, IntegrationCheck> = {
  // notify/discord/config.go; config/config.go
  discord_configs: urlOrFile("webhook_url"),

  // config/notifiers.go EmailConfig; config/config.go (global SMTP defaults, HostPort)
  email_configs: (c, at, g, r) => {
    if (!has(c.to)) r.add("PROM209", `${at} has no to address`);
    if (!has(c.smarthost) && !has(g.smtp_smarthost)) r.add("PROM209", `${at} has no smarthost, and global sets no smtp_smarthost`);
    if (!has(c.from) && !has(g.smtp_from)) r.add("PROM209", `${at} has no from address, and global sets no smtp_from`);
    if (has(c.smarthost) && !isHostPort(c.smarthost)) r.add("PROM210", `${at}.smarthost "${str(c.smarthost)}" is not host:port`);
    const seen = new Set<string>();
    for (const h of Object.keys(asObj(c.headers))) {
      const name = canonicalHeader(h);
      if (seen.has(name)) r.add("PROM210", `${at}.headers sets ${name} more than once (header names are case-insensitive)`);
      seen.add(name);
    }
    const threading = asObj(c.threading);
    if (threading.enabled === true) {
      for (const h of ["References", "In-Reply-To"]) {
        if (seen.has(h)) r.add("PROM210", `${at} enables threading and sets a ${h} header; threading writes that header itself`);
      }
      if (threading.thread_by_date !== "none" && threading.thread_by_date !== "daily") {
        r.add("PROM210", `${at}.threading.thread_by_date must be "none" or "daily" when threading is enabled`);
      }
    }
  },

  // notify/incidentio/config.go
  incidentio_configs: (c, at, _g, r) => {
    if (!has(c.url) && !has(c.url_file)) r.add("PROM209", `${at} has no url or url_file`);
    r.oneOf(c, at, "url");
    r.oneOf(c, at, "alert_source_token");
    const token = has(c.alert_source_token) || has(c.alert_source_token_file);
    const http = c.http_config !== undefined && c.http_config !== null;
    if (http && hasAuthorization(c.http_config) && token) {
      r.add("PROM210", `${at} sets alert_source_token(_file) and http_config.authorization; set one`);
    }
    // Alertmanager only asks for a credential when http_config is present.
    if (http && !hasAuthorization(c.http_config) && !token) {
      r.add("PROM209", `${at} has no alert_source_token(_file) and its http_config has no authorization`);
    }
    r.goDuration(c, at, "timeout");
  },

  // notify/jira/config.go; config/config.go (global.jira_api_url, which has no default)
  jira_configs: (c, at, g, r) => {
    if (!has(c.project)) r.add("PROM209", `${at} has no project`);
    if (!has(c.issue_type)) r.add("PROM209", `${at} has no issue_type`);
    if (!has(c.api_url) && !has(g.jira_api_url)) r.add("PROM209", `${at} has no api_url, and global sets no jira_api_url`);
    if (has(c.api_type) && !JIRA_API_TYPES.includes(str(c.api_type))) {
      r.add("PROM210", `${at}.api_type "${str(c.api_type)}" must be auto, cloud or datacenter`);
    }
    r.promDuration(c, at, "reopen_duration");
  },

  // notify/mattermost/config.go; config/config.go (global.mattermost_webhook_url)
  mattermost_configs: (c, at, g, r) => {
    if (!has(c.webhook_url) && !has(c.webhook_url_file) && !has(g.mattermost_webhook_url) && !has(g.mattermost_webhook_url_file)) {
      r.add("PROM209", `${at} has no webhook_url or webhook_url_file, and global sets no mattermost_webhook_url(_file)`);
    }
    r.oneOf(c, at, "webhook_url");
    titledFields(c, at, r);
    asList(c.attachments).forEach((a, j) => titledFields(asObj(a), `${at}.attachments[${j}]`, r));
  },

  // notify/msteams/config.go, notify/msteamsv2/config.go
  msteams_configs: urlOrFile("webhook_url"),
  msteamsv2_configs: urlOrFile("webhook_url"),

  // notify/opsgenie/config.go; config/config.go (global.opsgenie_api_key)
  opsgenie_configs: (c, at, g, r) => {
    if (!has(c.api_key) && !has(c.api_key_file) && !has(g.opsgenie_api_key) && !has(g.opsgenie_api_key_file)) {
      r.add("PROM209", `${at} has no api_key or api_key_file, and global sets no opsgenie_api_key(_file)`);
    }
    r.oneOf(c, at, "api_key");
    asList(c.responders).forEach((x, j) => {
      const resp = asObj(x);
      if (!has(resp.id) && !has(resp.username) && !has(resp.name)) {
        r.add("PROM209", `${at}.responders[${j}] has none of id, username or name`);
      }
      const type = str(resp.type ?? "");
      if (type === "") r.add("PROM209", `${at}.responders[${j}] has no type`);
      else if (!type.includes("{{") && !OPSGENIE_RESPONDER_TYPES.includes(type.toLowerCase())) {
        r.add("PROM210", `${at}.responders[${j}].type "${type}" must be team, teams, user, escalation or schedule`);
      }
    });
  },

  // notify/pagerduty/config.go
  pagerduty_configs: (c, at, _g, r) => {
    if (!has(c.routing_key) && !has(c.routing_key_file) && !has(c.service_key) && !has(c.service_key_file)) {
      r.add("PROM209", `${at} has no routing_key(_file) or service_key(_file)`);
    }
    r.oneOf(c, at, "routing_key");
    r.oneOf(c, at, "service_key");
    r.goDuration(c, at, "timeout");
  },

  // config/notifiers.go PushoverConfig
  pushover_configs: (c, at, _g, r) => {
    if (!has(c.user_key) && !has(c.user_key_file)) r.add("PROM209", `${at} has no user_key or user_key_file`);
    r.oneOf(c, at, "user_key");
    if (!has(c.token) && !has(c.token_file)) r.add("PROM209", `${at} has no token or token_file`);
    r.oneOf(c, at, "token");
    if (c.html === true && c.monospace === true) r.add("PROM210", `${at} sets both html and monospace; set at most one`);
    for (const f of ["retry", "expire", "ttl"]) r.goDuration(c, at, f);
  },

  // config/notifiers.go RocketchatConfig; config/config.go (global.rocketchat_token(_id))
  rocketchat_configs: (c, at, g, r) => {
    r.oneOf(c, at, "token");
    r.oneOf(c, at, "token_id");
    if (!has(c.token_id) && !has(c.token_id_file) && !has(g.rocketchat_token_id) && !has(g.rocketchat_token_id_file)) {
      r.add("PROM209", `${at} has no token_id or token_id_file, and global sets no rocketchat_token_id(_file)`);
    }
    if (!has(c.token) && !has(c.token_file) && !has(g.rocketchat_token) && !has(g.rocketchat_token_file)) {
      r.add("PROM209", `${at} has no token or token_file, and global sets no rocketchat_token(_file)`);
    }
  },

  // config/notifiers.go SlackConfig, SlackField, SlackAction, SlackConfirmationField; config/config.go
  slack_configs: (c, at, g, r) => {
    r.oneOf(c, at, "api_url");
    r.oneOf(c, at, "app_token");
    const url = has(c.api_url) || has(c.api_url_file);
    const token = has(c.app_token) || has(c.app_token_file);
    const auth = hasAuthorization(c.http_config);
    if (url && token) r.add("PROM210", `${at} sets both api_url(_file) and app_token(_file); set one`);
    if (c.update_message === true && c.api_url !== SLACK_APP_URL) {
      r.add("PROM210", `${at} sets update_message, which needs api_url set to ${SLACK_APP_URL} and the bot token in http_config.authorization`);
    }
    // The global app token only applies with no local authorization and no local api_url.
    const globalToken = (has(g.slack_app_token) || has(g.slack_app_token_file)) && !auth && !url;
    const globalUrl = has(g.slack_api_url) || has(g.slack_api_url_file);
    if (!url && !token && !globalToken && !globalUrl) {
      r.add("PROM209", `${at} has no api_url(_file) or app_token(_file), and global sets no slack_api_url(_file) or slack_app_token(_file)`);
    }
    if (token && auth) r.add("PROM210", `${at} sets app_token(_file) and http_config.authorization; the app token is the authorization`);
    titledFields(c, at, r);
    asList(c.actions).forEach((x, j) => {
      const a = asObj(x);
      if (!has(a.type)) r.add("PROM210", `${at}.actions[${j}] has no type`);
      if (!has(a.text)) r.add("PROM210", `${at}.actions[${j}] has no text`);
      if (!has(a.url) && !has(a.name)) r.add("PROM210", `${at}.actions[${j}] has no url or name`);
      if (a.confirm !== undefined && a.confirm !== null && !has(asObj(a.confirm).text)) {
        r.add("PROM210", `${at}.actions[${j}].confirm has no text`);
      }
    });
    r.goDuration(c, at, "timeout");
  },

  // config/notifiers.go SNSConfig. Go's check is a chained XOR, so all three set passes; it is mirrored as is.
  sns_configs: (c, at, _g, r) => {
    const n = ["topic_arn", "phone_number", "target_arn"].filter((f) => has(c[f])).length;
    if (n === 0) r.add("PROM209", `${at} has none of topic_arn, phone_number or target_arn`);
    if (n === 2) r.add("PROM210", `${at} sets two of topic_arn, phone_number and target_arn; set one`);
  },

  // notify/telegram/config.go; config/config.go (global.telegram_bot_token)
  telegram_configs: (c, at, g, r) => {
    r.oneOf(c, at, "bot_token");
    const chat = has(c.chat_id) && c.chat_id !== 0;
    if (!chat && !has(c.chat_id_file)) r.add("PROM209", `${at} has no chat_id or chat_id_file`);
    if (chat && has(c.chat_id_file)) r.add("PROM210", `${at} sets both chat_id and chat_id_file; set at most one`);
    if (has(c.parse_mode) && !TELEGRAM_PARSE_MODES.includes(str(c.parse_mode))) {
      r.add("PROM210", `${at}.parse_mode "${str(c.parse_mode)}" must be Markdown, MarkdownV2 or HTML`);
    }
    if (!has(c.bot_token) && !has(c.bot_token_file) && !has(g.telegram_bot_token) && !has(g.telegram_bot_token_file)) {
      r.add("PROM209", `${at} has no bot_token or bot_token_file, and global sets no telegram_bot_token(_file)`);
    }
  },

  // config/notifiers.go VictorOpsConfig; config/config.go (global.victorops_api_key)
  victorops_configs: (c, at, g, r) => {
    if (!has(c.routing_key)) r.add("PROM209", `${at} has no routing_key`);
    r.oneOf(c, at, "api_key");
    for (const f of Object.keys(asObj(c.custom_fields))) {
      if (VICTOROPS_RESERVED.includes(f)) r.add("PROM210", `${at}.custom_fields sets ${f}, which VictorOps reserves`);
    }
    if (!has(c.api_key) && !has(c.api_key_file) && !has(g.victorops_api_key) && !has(g.victorops_api_key_file)) {
      r.add("PROM209", `${at} has no api_key or api_key_file, and global sets no victorops_api_key(_file)`);
    }
  },

  // config/notifiers.go WebexConfig. The authorization must be on the integration: the global http_config is applied after the check.
  webex_configs: (c, at, _g, r) => {
    if (!has(c.room_id)) r.add("PROM209", `${at} has no room_id`);
    if (!hasAuthorization(c.http_config)) r.add("PROM209", `${at} has no http_config.authorization (the bot token)`);
  },

  // notify/webhook/config.go
  webhook_configs: (c, at, g, r) => {
    urlOrFile("url")(c, at, g, r);
    r.goDuration(c, at, "timeout");
  },

  // config/notifiers.go WechatConfig; config/config.go (global.wechat_api_secret, global.wechat_api_corp_id)
  wechat_configs: (c, at, g, r) => {
    if (has(c.message_type) && c.message_type !== "text" && c.message_type !== "markdown") {
      r.add("PROM210", `${at}.message_type "${str(c.message_type)}" must be text or markdown`);
    }
    r.oneOf(c, at, "api_secret");
    if (!has(c.api_secret) && !has(c.api_secret_file) && !has(g.wechat_api_secret) && !has(g.wechat_api_secret_file)) {
      r.add("PROM209", `${at} has no api_secret or api_secret_file, and global sets no wechat_api_secret(_file)`);
    }
    if (!has(c.corp_id) && !has(g.wechat_api_corp_id)) r.add("PROM209", `${at} has no corp_id, and global sets no wechat_api_corp_id`);
  },
};

/** PROM208-PROM210 findings for every integration of one receiver. */
export function validateReceiverIntegrations(receiver: ReceiverConfig, global: AlertmanagerGlobalConfig): PrometheusIssue[] {
  const name = str(receiver?.name ?? "");
  const r = new Reporter(name, `receiver "${name}" `);
  const g = asObj(global);
  const rec = receiver as unknown as Obj;
  for (const [key, check] of Object.entries(CHECKS)) {
    asList(rec[key]).forEach((entry, i) => check(asObj(entry), `${key}[${i}]`, g, r));
  }
  return r.issues;
}

const GLOBAL_FILE_PAIRS = [
  "slack_app_token",
  "slack_api_url",
  "opsgenie_api_key",
  "victorops_api_key",
  "telegram_bot_token",
  "smtp_auth_password",
  "rocketchat_token",
  "rocketchat_token_id",
  "smtp_auth_secret",
  "wechat_api_secret",
  "mattermost_webhook_url",
];

/** PROM208 and PROM210 findings for `global:` (config/config.go `Config.UnmarshalYAML`). */
export function validateGlobalSettings(global: AlertmanagerGlobalConfig): PrometheusIssue[] {
  const g = asObj(global);
  const r = new Reporter("global", "");
  r.promDuration(g, "global", "resolve_timeout");
  for (const f of GLOBAL_FILE_PAIRS) r.oneOf(g, "global", f);
  const token = has(g.slack_app_token) || has(g.slack_app_token_file);
  const url = has(g.slack_api_url) || has(g.slack_api_url_file);
  // Kept working for configs that point slack_api_url at the app URL and add a token (alertmanager#2513).
  if (token && url && g.slack_api_url !== (g.slack_app_url ?? SLACK_APP_URL)) {
    r.add("PROM210", "global sets both slack_app_token(_file) and slack_api_url(_file); set one, or set slack_api_url to the slack_app_url");
  }
  if (has(g.smtp_smarthost) && !isHostPort(g.smtp_smarthost)) {
    r.add("PROM210", `global.smtp_smarthost "${str(g.smtp_smarthost)}" is not host:port`);
  }
  return r.issues;
}
