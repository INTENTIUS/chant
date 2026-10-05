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

import {
  RECEIVER_INTEGRATION_TYPES,
  type DiscordConfig,
  type EmailConfig,
  type HttpClientConfig,
  type IncidentioConfig,
  type JiraConfig,
  type MattermostConfig,
  type MSTeamsConfig,
  type MSTeamsV2Config,
  type OpsGenieConfig,
  type PagerDutyConfig,
  type PushoverConfig,
  type ReceiverIntegration,
  type RocketchatConfig,
  type SlackConfig,
  type SNSConfig,
  type TelegramConfig,
  type TlsConfig,
  type VictorOpsConfig,
  type WebexConfig,
  type WebhookConfig,
  type WechatConfig,
} from "./integrations";

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

export * from "./integrations";
export * from "./config-model";

/** One entry under `receivers:`. */
export interface ReceiverConfig {
  name: string;
  /** Labels on the receiver, exposed to notification templates. */
  labels?: LabelSet;
  discord_configs?: DiscordConfig[];
  email_configs?: EmailConfig[];
  incidentio_configs?: IncidentioConfig[];
  pagerduty_configs?: PagerDutyConfig[];
  slack_configs?: SlackConfig[];
  webhook_configs?: WebhookConfig[];
  opsgenie_configs?: OpsGenieConfig[];
  wechat_configs?: WechatConfig[];
  pushover_configs?: PushoverConfig[];
  victorops_configs?: VictorOpsConfig[];
  sns_configs?: SNSConfig[];
  telegram_configs?: TelegramConfig[];
  webex_configs?: WebexConfig[];
  msteams_configs?: MSTeamsConfig[];
  msteamsv2_configs?: MSTeamsV2Config[];
  jira_configs?: JiraConfig[];
  rocketchat_configs?: RocketchatConfig[];
  mattermost_configs?: MattermostConfig[];
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
  /**
   * Labels on the route, inherited by child routes and exposed to
   * notification templates as `routeLabels`. Values may be Go templates.
   */
  labels?: LabelSet;
  routes?: RouteConfig[];
}

/** One entry under `inhibit_rules:`. */
export interface InhibitRuleConfig {
  /** A name for the rule, shown in Alertmanager's logs and metrics. */
  name?: string;
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

/**
 * `global:` settings: defaults the receivers fall back to. Credentials with
 * a `*_file` sibling are best set through it; PROM001 flags a literal.
 */
export interface AlertmanagerGlobalConfig {
  /** How long an alert that stops being updated stays firing. */
  resolve_timeout?: string;
  http_config?: HttpClientConfig;
  jira_api_url?: string;
  smtp_from?: string;
  smtp_hello?: string;
  smtp_smarthost?: string;
  smtp_auth_username?: string;
  smtp_auth_password?: string;
  smtp_auth_password_file?: string;
  smtp_auth_secret?: string;
  smtp_auth_secret_file?: string;
  smtp_auth_identity?: string;
  smtp_require_tls?: boolean;
  smtp_tls_config?: TlsConfig;
  smtp_force_implicit_tls?: boolean;
  slack_api_url?: string;
  slack_api_url_file?: string;
  slack_app_token?: string;
  slack_app_token_file?: string;
  slack_app_url?: string;
  pagerduty_url?: string;
  opsgenie_api_url?: string;
  opsgenie_api_key?: string;
  opsgenie_api_key_file?: string;
  wechat_api_url?: string;
  wechat_api_secret?: string;
  wechat_api_secret_file?: string;
  wechat_api_corp_id?: string;
  victorops_api_url?: string;
  victorops_api_key?: string;
  victorops_api_key_file?: string;
  telegram_api_url?: string;
  telegram_bot_token?: string;
  telegram_bot_token_file?: string;
  webex_api_url?: string;
  rocketchat_api_url?: string;
  rocketchat_token?: string;
  rocketchat_token_file?: string;
  rocketchat_token_id?: string;
  rocketchat_token_id_file?: string;
  mattermost_webhook_url?: string;
  mattermost_webhook_url_file?: string;
}

/** Every `global:` field, as a list, for code that reads a parsed file. */
export const ALERTMANAGER_GLOBAL_FIELDS = Object.freeze(Object.keys({
  resolve_timeout: true,
  http_config: true,
  jira_api_url: true,
  smtp_from: true,
  smtp_hello: true,
  smtp_smarthost: true,
  smtp_auth_username: true,
  smtp_auth_password: true,
  smtp_auth_password_file: true,
  smtp_auth_secret: true,
  smtp_auth_secret_file: true,
  smtp_auth_identity: true,
  smtp_require_tls: true,
  smtp_tls_config: true,
  smtp_force_implicit_tls: true,
  slack_api_url: true,
  slack_api_url_file: true,
  slack_app_token: true,
  slack_app_token_file: true,
  slack_app_url: true,
  pagerduty_url: true,
  opsgenie_api_url: true,
  opsgenie_api_key: true,
  opsgenie_api_key_file: true,
  wechat_api_url: true,
  wechat_api_secret: true,
  wechat_api_secret_file: true,
  wechat_api_corp_id: true,
  victorops_api_url: true,
  victorops_api_key: true,
  victorops_api_key_file: true,
  telegram_api_url: true,
  telegram_bot_token: true,
  telegram_bot_token_file: true,
  webex_api_url: true,
  rocketchat_api_url: true,
  rocketchat_token: true,
  rocketchat_token_file: true,
  rocketchat_token_id: true,
  rocketchat_token_id_file: true,
  mattermost_webhook_url: true,
  mattermost_webhook_url_file: true,
} satisfies Record<keyof AlertmanagerGlobalConfig, true>)) as readonly (keyof AlertmanagerGlobalConfig)[];

/** `tracing:` settings: where Alertmanager sends its own traces. */
export interface AlertmanagerTracingConfig {
  client_type?: "grpc" | "http";
  endpoint?: string;
  sampling_fraction?: number;
  insecure?: boolean;
  headers?: Record<string, string>;
  compression?: string;
  timeout?: string;
  tls_config?: TlsConfig;
}

/** A whole `alertmanager.yml`, the file `amtool check-config` reads. */
export interface AlertmanagerConfig {
  global?: AlertmanagerGlobalConfig;
  templates?: string[];
  route?: RouteConfig;
  inhibit_rules?: InhibitRuleConfig[];
  receivers?: ReceiverConfig[];
  time_intervals?: TimeIntervalConfig[];
  tracing?: AlertmanagerTracingConfig;
}

/** The receiver integrations, every one Alertmanager defines. */
export const RECEIVER_INTEGRATIONS = Object.keys(RECEIVER_INTEGRATION_TYPES) as readonly ReceiverIntegration[];

/** True when a parsed document has the shape of a Prometheus rule file. */
export function looksLikeRuleFile(value: unknown): value is RuleFileConfig {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  const groups = v.groups;
  if (!Array.isArray(groups)) return false;
  // Grafana's alerting provisioning files also hold `groups:` of named rule lists. Prometheus reads rule
  // files strictly (unknown keys are errors), so `apiVersion`, a group `folder` or a rule's `data` means Grafana.
  if ("apiVersion" in v) return false;
  return groups.every((g) => {
    if (typeof g !== "object" || g === null) return false;
    const group = g as Record<string, unknown>;
    if (typeof group.name !== "string" || !Array.isArray(group.rules) || "folder" in group) return false;
    return !group.rules.some((r) => typeof r === "object" && r !== null && "data" in r);
  });
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
