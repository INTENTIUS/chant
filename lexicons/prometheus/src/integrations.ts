/**
 * Alertmanager's receiver integrations and the HTTP client settings they
 * share, typed against the Go structs of the pinned release (see ./pin.ts):
 * `alertmanager/config` (`notifiers.go`), `alertmanager/notify/<name>`
 * (`config.go`), `prometheus/common/config` (`http_config.go`,
 * `headers.go`) and `prometheus/sigv4`.
 *
 * Field names are the YAML keys. Durations are strings (`30s`), secrets and
 * URLs are strings, and every credential with a `*_file` sibling is best
 * set through that sibling: Alertmanager does not expand environment
 * variables in its config, and PROM001 flags a literal.
 */

// ── Shared ──────────────────────────────────────────────────────────

/** `tls_config`: client TLS settings. */
export interface TlsConfig {
  /** A PEM CA certificate, inline. Set this or `ca_file`. */
  ca?: string;
  ca_file?: string;
  ca_ref?: string;
  cert?: string;
  cert_file?: string;
  cert_ref?: string;
  /** A PEM private key, inline. A credential: prefer `key_file`. */
  key?: string;
  key_file?: string;
  key_ref?: string;
  server_name?: string;
  insecure_skip_verify?: boolean;
  /** e.g. `TLS12`. */
  min_version?: string;
  max_version?: string;
}

/** One entry of `http_headers`: values written as is, as secrets, or read from files. */
export interface HttpHeaderConfig {
  values?: string[];
  secrets?: string[];
  files?: string[];
}

/** `oauth2`: the client-credentials (or JWT bearer) grant. */
export interface OAuth2Config {
  client_id?: string;
  client_secret?: string;
  client_secret_file?: string;
  client_secret_ref?: string;
  client_certificate_key_id?: string;
  client_certificate_key?: string;
  client_certificate_key_file?: string;
  client_certificate_key_ref?: string;
  grant_type?: string;
  signature_algorithm?: string;
  iss?: string;
  audience?: string;
  claims?: Record<string, unknown>;
  scopes?: string[];
  token_url?: string;
  endpoint_params?: Record<string, string>;
  tls_config?: TlsConfig;
  proxy_url?: string;
  no_proxy?: string;
  proxy_from_environment?: boolean;
  proxy_connect_header?: Record<string, string[]>;
}

/** HTTP client settings shared by the receivers that make HTTP calls. */
export interface HttpClientConfig {
  basic_auth?: {
    username?: string;
    username_file?: string;
    username_ref?: string;
    password?: string;
    password_file?: string;
    password_ref?: string;
  };
  authorization?: { type?: string; credentials?: string; credentials_file?: string; credentials_ref?: string };
  oauth2?: OAuth2Config;
  bearer_token?: string;
  bearer_token_file?: string;
  tls_config?: TlsConfig;
  follow_redirects?: boolean;
  enable_http2?: boolean;
  proxy_url?: string;
  no_proxy?: string;
  proxy_from_environment?: boolean;
  proxy_connect_header?: Record<string, string[]>;
  /** Headers added to every request, by header name. */
  http_headers?: Record<string, HttpHeaderConfig>;
}

interface NotifierBase {
  /** Whether to notify about resolved alerts too. */
  send_resolved?: boolean;
}

interface HttpNotifier extends NotifierBase {
  http_config?: HttpClientConfig;
}

// ── The integrations, in the order Alertmanager's Receiver declares them ──

/** `discord_configs`. */
export interface DiscordConfig extends HttpNotifier {
  /** The channel webhook URL. A credential: prefer `webhook_url_file`. */
  webhook_url?: string;
  webhook_url_file?: string;
  content?: string;
  title?: string;
  message?: string;
  username?: string;
  avatar_url?: string;
}

/** Email threading: group notifications for the same alert group into one thread. */
export interface EmailThreadingConfig {
  enabled?: boolean;
  /** `daily`, or `none` to thread for as long as the group lives. */
  thread_by_date?: string;
}

/** `email_configs`. */
export interface EmailConfig extends NotifierBase {
  to: string;
  from?: string;
  hello?: string;
  /** `host:port` of the SMTP server. Falls back to `global.smtp_smarthost`. */
  smarthost?: string;
  auth_username?: string;
  auth_password?: string;
  auth_password_file?: string;
  auth_secret?: string;
  auth_secret_file?: string;
  auth_identity?: string;
  headers?: Record<string, string>;
  html?: string;
  text?: string;
  require_tls?: boolean;
  tls_config?: TlsConfig;
  force_implicit_tls?: boolean;
  threading?: EmailThreadingConfig;
}

/** `incidentio_configs`. */
export interface IncidentioConfig extends HttpNotifier {
  /** The alert source URL. Set this or `url_file`. */
  url?: string;
  url_file?: string;
  /** A credential: prefer `alert_source_token_file`. */
  alert_source_token?: string;
  alert_source_token_file?: string;
  /** Most alerts per message; 0 sends them all. */
  max_alerts?: number;
  timeout?: string;
}

/** A Jira field's template, as a string or with whether it is rewritten on update. */
export type JiraFieldConfig = string | { template?: string; enable_update?: boolean };

/** `jira_configs`. */
export interface JiraConfig extends HttpNotifier {
  /** Falls back to `global.jira_api_url`. */
  api_url?: string;
  /** `auto`, `cloud` or `datacenter`. */
  api_type?: string;
  project?: string;
  summary?: JiraFieldConfig;
  description?: JiraFieldConfig;
  labels?: string[];
  priority?: string;
  issue_type?: string;
  reopen_transition?: string;
  resolve_transition?: string;
  wont_fix_resolution?: string;
  reopen_duration?: string;
  /** Other issue fields, by Jira field id. */
  fields?: Record<string, unknown>;
}

/** A field of a Mattermost attachment. */
export interface MattermostField {
  title?: string;
  value?: string;
  short?: boolean;
}

/** An attachment of a Mattermost message. */
export interface MattermostAttachment {
  fallback?: string;
  color?: string;
  pretext?: string;
  text?: string;
  author_name?: string;
  author_link?: string;
  author_icon?: string;
  title?: string;
  title_link?: string;
  fields?: MattermostField[];
  thumb_url?: string;
  footer?: string;
  footer_icon?: string;
  image_url?: string;
}

/** `mattermost_configs`. */
export interface MattermostConfig extends HttpNotifier {
  /** The incoming-webhook URL. A credential: prefer `webhook_url_file`. */
  webhook_url?: string;
  webhook_url_file?: string;
  channel?: string;
  username?: string;
  text?: string;
  fallback?: string;
  color?: string;
  pretext?: string;
  author_name?: string;
  author_link?: string;
  author_icon?: string;
  title?: string;
  title_link?: string;
  fields?: MattermostField[];
  thumb_url?: string;
  footer?: string;
  footer_icon?: string;
  image_url?: string;
  icon_url?: string;
  icon_emoji?: string;
  attachments?: MattermostAttachment[];
  type?: string;
  props?: { card?: string };
  priority?: { priority?: string; requested_ack?: boolean; persistent_notifications?: boolean };
}

/** `msteams_configs`: the Office 365 connector webhook. */
export interface MSTeamsConfig extends HttpNotifier {
  /** A credential: prefer `webhook_url_file`. */
  webhook_url?: string;
  webhook_url_file?: string;
  title?: string;
  summary?: string;
  text?: string;
}

/** `msteamsv2_configs`: the Power Automate (Workflows) webhook. */
export interface MSTeamsV2Config extends HttpNotifier {
  /** A credential: prefer `webhook_url_file`. */
  webhook_url?: string;
  webhook_url_file?: string;
  title?: string;
  text?: string;
}

/** Who an Opsgenie alert is assigned to: one of `id`, `name` or `username`, and a `type`. */
export interface OpsGenieResponder {
  id?: string;
  name?: string;
  username?: string;
  /** `team`, `teams`, `user`, `escalation` or `schedule`. */
  type: string;
}

/** `opsgenie_configs`. */
export interface OpsGenieConfig extends HttpNotifier {
  /** Falls back to `global.opsgenie_api_key`. A credential: prefer `api_key_file`. */
  api_key?: string;
  api_key_file?: string;
  api_url?: string;
  message?: string;
  description?: string;
  source?: string;
  details?: Record<string, string>;
  entity?: string;
  responders?: OpsGenieResponder[];
  /** Comma-separated. */
  actions?: string;
  /** Comma-separated. */
  tags?: string;
  note?: string;
  /** `P1` to `P5`. */
  priority?: string;
  update_alerts?: boolean;
}

/** `pagerduty_configs`. */
export interface PagerDutyConfig extends HttpNotifier {
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
  details?: Record<string, unknown>;
  images?: Array<{ src?: string; alt?: string; href?: string }>;
  links?: Array<{ href?: string; text?: string }>;
  source?: string;
  severity?: string;
  class?: string;
  component?: string;
  group?: string;
  timeout?: string;
}

/** A Slack message button. */
export interface SlackAction {
  type: string;
  text: string;
  url?: string;
  style?: string;
  name?: string;
  value?: string;
  confirm?: { text: string; title?: string; ok_text?: string; dismiss_text?: string };
}

/** `slack_configs`. */
export interface SlackConfig extends HttpNotifier {
  /** The incoming-webhook URL. It is a credential: prefer `api_url_file`. */
  api_url?: string;
  api_url_file?: string;
  /** A Slack app bot token, used with `app_url`. A credential: prefer `app_token_file`. */
  app_token?: string;
  app_token_file?: string;
  app_url?: string;
  channel?: string;
  username?: string;
  color?: string;
  title?: string;
  title_link?: string;
  pretext?: string;
  text?: string;
  /** The message's top-level text, shown in notifications. */
  message_text?: string;
  fields?: Array<{ title: string; value: string; short?: boolean }>;
  short_fields?: boolean;
  footer?: string;
  fallback?: string;
  callback_id?: string;
  icon_emoji?: string;
  icon_url?: string;
  image_url?: string;
  thumb_url?: string;
  link_names?: boolean;
  mrkdwn_in?: string[];
  actions?: SlackAction[];
  /** Edit the first message for the alert group instead of posting a new one (app token only). */
  update_message?: boolean;
  timeout?: string;
}

/** `webhook_configs`. */
export interface WebhookConfig extends HttpNotifier {
  /** Where alerts are POSTed. Set this or `url_file`. */
  url?: string;
  url_file?: string;
  /** Most alerts per message; 0 sends them all. */
  max_alerts?: number;
  timeout?: string;
  /** A custom body, rendered as templates, in place of the default JSON. */
  payload?: unknown;
}

/** `wechat_configs`. */
export interface WechatConfig extends HttpNotifier {
  /** Falls back to `global.wechat_api_secret`. A credential: prefer `api_secret_file`. */
  api_secret?: string;
  api_secret_file?: string;
  corp_id?: string;
  message?: string;
  api_url?: string;
  to_user?: string;
  to_party?: string;
  to_tag?: string;
  /** Go reads a number here as its string. */
  agent_id?: string | number;
  /** `text` or `markdown`. */
  message_type?: string;
}

/** `pushover_configs`. */
export interface PushoverConfig extends HttpNotifier {
  /** A credential: prefer `user_key_file`. */
  user_key?: string;
  user_key_file?: string;
  /** A credential: prefer `token_file`. */
  token?: string;
  token_file?: string;
  title?: string;
  message?: string;
  url?: string;
  url_title?: string;
  device?: string;
  sound?: string;
  /** Often a template; Go reads a number here as its string. */
  priority?: string | number;
  retry?: string;
  expire?: string;
  ttl?: string;
  html?: boolean;
  monospace?: boolean;
}

/** `victorops_configs`. */
export interface VictorOpsConfig extends HttpNotifier {
  /** Falls back to `global.victorops_api_key`. A credential: prefer `api_key_file`. */
  api_key?: string;
  api_key_file?: string;
  api_url?: string;
  routing_key: string;
  message_type?: string;
  state_message?: string;
  entity_display_name?: string;
  monitoring_tool?: string;
  custom_fields?: Record<string, string>;
}

/** AWS Signature v4 signing for `sns_configs`. */
export interface SigV4Config {
  region?: string;
  access_key?: string;
  secret_key?: string;
  profile?: string;
  role_arn?: string;
  external_id?: string;
  use_fips_sts_endpoint?: boolean;
  service_name?: string;
}

/** `sns_configs`. Set one of `topic_arn`, `phone_number` or `target_arn`. */
export interface SNSConfig extends HttpNotifier {
  api_url?: string;
  sigv4?: SigV4Config;
  topic_arn?: string;
  phone_number?: string;
  target_arn?: string;
  subject?: string;
  message?: string;
  attributes?: Record<string, string>;
  use_aws_http_client?: boolean;
}

/** `telegram_configs`. */
export interface TelegramConfig extends HttpNotifier {
  api_url?: string;
  /** A credential: prefer `bot_token_file`. */
  bot_token?: string;
  bot_token_file?: string;
  chat_id?: number;
  chat_id_file?: string;
  message_thread_id?: number;
  message?: string;
  disable_notifications?: boolean;
  /** `MarkdownV2`, `Markdown` or `HTML`. */
  parse_mode?: string;
}

/** `webex_configs`. */
export interface WebexConfig extends HttpNotifier {
  /** Falls back to `global.webex_api_url`. The credential goes in `http_config.authorization`. */
  api_url?: string;
  message?: string;
  room_id: string;
}

/**
 * A field of a Rocket.Chat attachment. Alertmanager declares these structs
 * without YAML tags, so the keys are the Go field names in lower case.
 */
export interface RocketchatAttachmentField {
  short?: boolean;
  title?: string;
  value?: string;
}

/** A Rocket.Chat attachment button. Keys are the Go field names in lower case, as for fields. */
export interface RocketchatAttachmentAction {
  type?: string;
  text?: string;
  url?: string;
  imageurl?: string;
  iswebview?: boolean;
  webviewheightratio?: string;
  msg?: string;
  msginchatwindow?: boolean;
  msgprocessingtype?: string;
}

/** `rocketchat_configs`. */
export interface RocketchatConfig extends HttpNotifier {
  api_url?: string;
  /** A credential: prefer `token_id_file`. */
  token_id?: string;
  token_id_file?: string;
  /** A credential: prefer `token_file`. */
  token?: string;
  token_file?: string;
  channel?: string;
  color?: string;
  title?: string;
  title_link?: string;
  text?: string;
  fields?: RocketchatAttachmentField[];
  short_fields?: boolean;
  emoji?: string;
  icon_url?: string;
  image_url?: string;
  thumb_url?: string;
  link_names?: boolean;
  actions?: RocketchatAttachmentAction[];
}

/** Every receiver integration: its key under a receiver, and the name of the type of one entry. */
export const RECEIVER_INTEGRATION_TYPES = Object.freeze({
  discord_configs: "DiscordConfig",
  email_configs: "EmailConfig",
  incidentio_configs: "IncidentioConfig",
  pagerduty_configs: "PagerDutyConfig",
  slack_configs: "SlackConfig",
  webhook_configs: "WebhookConfig",
  opsgenie_configs: "OpsGenieConfig",
  wechat_configs: "WechatConfig",
  pushover_configs: "PushoverConfig",
  victorops_configs: "VictorOpsConfig",
  sns_configs: "SNSConfig",
  telegram_configs: "TelegramConfig",
  webex_configs: "WebexConfig",
  msteams_configs: "MSTeamsConfig",
  msteamsv2_configs: "MSTeamsV2Config",
  jira_configs: "JiraConfig",
  rocketchat_configs: "RocketchatConfig",
  mattermost_configs: "MattermostConfig",
} as const);

/** The receiver keys that hold integrations. */
export type ReceiverIntegration = keyof typeof RECEIVER_INTEGRATION_TYPES;
