/**
 * The plain-data model of a Prometheus rule file and an Alertmanager config.
 *
 * Everything else in this lexicon reads or writes these shapes: the serializer
 * builds them from declared entities, the YAML emitter prints them, the checks
 * validate them, and other lexicons (the k8s `PrometheusRule`, the SLO
 * composite, Grafana panels) read them. They are exactly the files' own
 * layouts, so a parsed rule file or `alertmanager.yml` already is one and
 * needs no conversion.
 *
 * Field names keep the files' snake_case (`keep_firing_for`, `group_wait`),
 * so a declaration reads the same as the file it produces and the upstream
 * docs apply word for word.
 */

/** Labels or annotations: string keys to string values. */
export type LabelSet = Record<string, string>;

/** A recording rule: evaluates `expr` and stores the result as the series `record`. */
export interface RecordingRuleConfig {
  /** The metric name the result is stored under, e.g. `job:http_requests:rate5m`. */
  record: string;
  /** The PromQL expression. */
  expr: string;
  /** Labels added to the stored series. */
  labels?: LabelSet;
}

/** An alerting rule: fires while `expr` returns anything, after `for`. */
export interface AlertingRuleConfig {
  /** The alert name, the `alertname` label on every alert it fires. */
  alert: string;
  /** The PromQL expression. Every series it returns is one alert. */
  expr: string;
  /** How long the expression must hold before the alert fires, e.g. `5m`. */
  for?: string;
  /** How long the alert keeps firing after the expression stops returning it. */
  keep_firing_for?: string;
  /** Labels added to the alert. Alertmanager routes on these; set `severity`. */
  labels?: LabelSet;
  /** Annotations added to the alert, e.g. `summary`, `description`, `runbook_url`. */
  annotations?: LabelSet;
}

export type RuleConfig = RecordingRuleConfig | AlertingRuleConfig;

/** One entry under `groups:` in a rule file, and one entry in a `PrometheusRule`'s `spec.groups`. */
export interface RuleGroupConfig {
  name: string;
  /** How often the group is evaluated. Defaults to the global `evaluation_interval`. */
  interval?: string;
  /** Evaluate the group this far in the past, for late-arriving data. */
  query_offset?: string;
  /** Cap on alerts (alerting rules) or series (recording rules) a rule may produce; 0 is no limit. */
  limit?: number;
  /** Labels added to every rule in the group. A rule's own labels win. */
  labels?: LabelSet;
  rules: RuleConfig[];
}

/** A whole rule file, the YAML `rule_files:` points at and `promtool check rules` reads. */
export interface RuleFileConfig {
  groups: RuleGroupConfig[];
}

export function isRecordingRuleConfig(rule: unknown): rule is RecordingRuleConfig {
  return typeof rule === "object" && rule !== null && typeof (rule as { record?: unknown }).record === "string";
}

export function isAlertingRuleConfig(rule: unknown): rule is AlertingRuleConfig {
  return typeof rule === "object" && rule !== null && typeof (rule as { alert?: unknown }).alert === "string";
}

/** The rule's name: `record` for a recording rule, `alert` for an alerting rule. */
export function ruleName(rule: RuleConfig): string {
  return isRecordingRuleConfig(rule) ? rule.record : (rule as AlertingRuleConfig).alert;
}

// ── Alertmanager ────────────────────────────────────────────────────

/** HTTP client settings shared by the receivers that make HTTP calls. */
export interface HttpClientConfig {
  basic_auth?: { username?: string; username_file?: string; password?: string; password_file?: string };
  authorization?: { type?: string; credentials?: string; credentials_file?: string };
  bearer_token?: string;
  bearer_token_file?: string;
  oauth2?: Record<string, unknown>;
  proxy_url?: string;
  follow_redirects?: boolean;
  enable_http2?: boolean;
  tls_config?: {
    ca_file?: string;
    cert_file?: string;
    key_file?: string;
    server_name?: string;
    insecure_skip_verify?: boolean;
    min_version?: string;
  };
}

interface NotifierBase {
  /** Whether to notify about resolved alerts too. */
  send_resolved?: boolean;
}

export interface WebhookConfig extends NotifierBase {
  /** Where alerts are POSTed. Set this or `url_file`. */
  url?: string;
  url_file?: string;
  http_config?: HttpClientConfig;
  /** Most alerts per message; 0 sends them all. */
  max_alerts?: number;
  timeout?: string;
}

export interface EmailConfig extends NotifierBase {
  to: string;
  from?: string;
  /** `host:port` of the SMTP server. Falls back to `global.smtp_smarthost`. */
  smarthost?: string;
  hello?: string;
  auth_username?: string;
  auth_password?: string;
  auth_password_file?: string;
  auth_secret?: string;
  auth_secret_file?: string;
  auth_identity?: string;
  require_tls?: boolean;
  tls_config?: HttpClientConfig["tls_config"];
  html?: string;
  text?: string;
  headers?: Record<string, string>;
}

export interface SlackConfig extends NotifierBase {
  /** The incoming-webhook URL. It is a credential: prefer `api_url_file`. */
  api_url?: string;
  api_url_file?: string;
  channel?: string;
  username?: string;
  color?: string;
  title?: string;
  title_link?: string;
  pretext?: string;
  text?: string;
  footer?: string;
  fallback?: string;
  icon_emoji?: string;
  icon_url?: string;
  link_names?: boolean;
  short_fields?: boolean;
  mrkdwn_in?: string[];
  fields?: Array<{ title: string; value: string; short?: boolean }>;
  actions?: Array<Record<string, unknown>>;
  http_config?: HttpClientConfig;
}

export interface PagerDutyConfig extends NotifierBase {
  /** Events API v2 integration key. A credential: prefer `routing_key_file`. */
  routing_key?: string;
  routing_key_file?: string;
  /** Events API v1 integration key. A credential: prefer `service_key_file`. */
  service_key?: string;
  service_key_file?: string;
  url?: string;
  client?: string;
  client_url?: string;
  description?: string;
  severity?: string;
  class?: string;
  component?: string;
  group?: string;
  source?: string;
  details?: Record<string, string>;
  links?: Array<{ href: string; text?: string }>;
  images?: Array<{ src: string; alt?: string; href?: string }>;
  http_config?: HttpClientConfig;
}

/** One entry under `receivers:`. */
export interface ReceiverConfig {
  name: string;
  webhook_configs?: WebhookConfig[];
  email_configs?: EmailConfig[];
  slack_configs?: SlackConfig[];
  pagerduty_configs?: PagerDutyConfig[];
}

/** A route in the routing tree. The top-level `route:` is the root. */
export interface RouteConfig {
  receiver?: string;
  group_by?: string[];
  continue?: boolean;
  /** Matchers in Alertmanager's syntax, e.g. `severity="critical"` or `team=~"db|infra"`. */
  matchers?: string[];
  group_wait?: string;
  group_interval?: string;
  repeat_interval?: string;
  mute_time_intervals?: string[];
  active_time_intervals?: string[];
  routes?: RouteConfig[];
}

/** One entry under `inhibit_rules:`. */
export interface InhibitRuleConfig {
  source_matchers?: string[];
  target_matchers?: string[];
  /** Labels that must be equal on source and target for the inhibition to apply. */
  equal?: string[];
}

export interface TimeRangeConfig {
  start_time: string;
  end_time: string;
}

/** One period inside a time interval. Every field left out matches everything. */
export interface TimePeriodConfig {
  times?: TimeRangeConfig[];
  /** e.g. `monday:friday`, `saturday`. */
  weekdays?: string[];
  /** e.g. `1:5`, `-1`. */
  days_of_month?: string[];
  /** e.g. `january:march`, `12`. */
  months?: string[];
  /** e.g. `2026:2027`. */
  years?: string[];
  /** An IANA time zone name, e.g. `Europe/Berlin`. Defaults to UTC. */
  location?: string;
}

/** One entry under `time_intervals:`. */
export interface TimeIntervalConfig {
  name: string;
  time_intervals: TimePeriodConfig[];
}

/** `global:` settings. */
export interface AlertmanagerGlobalConfig {
  resolve_timeout?: string;
  smtp_from?: string;
  smtp_smarthost?: string;
  smtp_hello?: string;
  smtp_auth_username?: string;
  smtp_auth_password?: string;
  smtp_auth_password_file?: string;
  smtp_auth_secret?: string;
  smtp_auth_secret_file?: string;
  smtp_auth_identity?: string;
  smtp_require_tls?: boolean;
  slack_api_url?: string;
  slack_api_url_file?: string;
  pagerduty_url?: string;
  http_config?: HttpClientConfig;
}

/** A whole `alertmanager.yml`, the file `amtool check-config` reads. */
export interface AlertmanagerConfig {
  global?: AlertmanagerGlobalConfig;
  templates?: string[];
  route?: RouteConfig;
  inhibit_rules?: InhibitRuleConfig[];
  receivers?: ReceiverConfig[];
  time_intervals?: TimeIntervalConfig[];
}

/** The four receiver integrations this lexicon types. */
export const RECEIVER_INTEGRATIONS = ["webhook_configs", "email_configs", "slack_configs", "pagerduty_configs"] as const;

/** True when a parsed document has the shape of a Prometheus rule file. */
export function looksLikeRuleFile(value: unknown): value is RuleFileConfig {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const groups = (value as Record<string, unknown>).groups;
  if (!Array.isArray(groups)) return false;
  return groups.every(
    (g) => typeof g === "object" && g !== null && typeof (g as Record<string, unknown>).name === "string" && Array.isArray((g as Record<string, unknown>).rules),
  );
}

/** True when a parsed document has the shape of an `alertmanager.yml`. */
export function looksLikeAlertmanagerConfig(value: unknown): value is AlertmanagerConfig {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  const route = v.route;
  const receivers = v.receivers;
  const hasRoute = typeof route === "object" && route !== null && !Array.isArray(route);
  const hasReceivers = Array.isArray(receivers);
  // A k8s manifest never has both at the top level; a collector config has neither.
  return (hasRoute || hasReceivers) && !("apiVersion" in v) && !("kind" in v);
}
