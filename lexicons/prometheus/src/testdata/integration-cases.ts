/**
 * Alertmanager receiver integrations that pass and fail PROM208-PROM210: at
 * least one of each per integration, after Alertmanager v0.34.1's
 * UnmarshalYAML validations (sources in ../validate-integrations.ts).
 * post-synth.test.ts checks the codes; tools.test.ts has amtool reject the
 * failing ones when it is installed.
 *
 * Each case: a label, the receiver key, one entry, an optional `global:`,
 * and the PROM208-PROM210 codes it produces, sorted.
 */

export type IntegrationCase = [label: string, key: string, entry: Record<string, unknown>, global: Record<string, unknown> | undefined, codes: string[]];
const PD = "https://events.pagerduty.com/v2/enqueue";
export const SLACK_APP_URL = "https://slack.com/api/chat.postMessage";
export const INTEGRATION_CASES: IntegrationCase[] = [
  ["discord ok", "discord_configs", { webhook_url_file: "/s" }, undefined, []],
  ["discord without a webhook", "discord_configs", {}, undefined, ["PROM209"]],
  ["discord with url and file", "discord_configs", { webhook_url: "https://d/x", webhook_url_file: "/s" }, undefined, ["PROM210"]],
  ["email ok", "email_configs", { to: "a@b.c", from: "am@b.c", smarthost: "smtp:25" }, undefined, []],
  ["email on global SMTP", "email_configs", { to: "a@b.c" }, { smtp_smarthost: "smtp:25", smtp_from: "am@b.c" }, []],
  ["email with nothing", "email_configs", {}, undefined, ["PROM209", "PROM209", "PROM209"]],
  ["email smarthost without port", "email_configs", { to: "a@b.c", from: "am@b.c", smarthost: "smtp" }, undefined, ["PROM210"]],
  ["email duplicate header", "email_configs", { to: "a@b.c", from: "f@b.c", smarthost: "s:25", headers: { subject: "a", Subject: "b" } }, undefined, ["PROM210"]],
  ["email threading without thread_by_date", "email_configs", { to: "a@b.c", from: "f@b.c", smarthost: "s:25", threading: { enabled: true } }, undefined, ["PROM210"]],
  ["email threading with References", "email_configs", { to: "a@b.c", from: "f@b.c", smarthost: "s:25", headers: { references: "x" }, threading: { enabled: true, thread_by_date: "daily" } }, undefined, ["PROM210"]],
  ["incident.io ok", "incidentio_configs", { url: "https://i/x", alert_source_token_file: "/t", timeout: "1.5s" }, undefined, []],
  ["incident.io without url", "incidentio_configs", {}, undefined, ["PROM209"]],
  ["incident.io http_config without a credential", "incidentio_configs", { url: "https://i/x", http_config: { follow_redirects: true } }, undefined, ["PROM209"]],
  ["incident.io token and authorization", "incidentio_configs", { url: "https://i/x", alert_source_token_file: "/t", http_config: { authorization: { credentials_file: "/c" } } }, undefined, ["PROM210"]],
  ["incident.io Prometheus-only duration", "incidentio_configs", { url_file: "/u", timeout: "1d" }, undefined, ["PROM208"]],
  ["jira ok", "jira_configs", { api_url: "https://j/x", project: "OPS", issue_type: "Bug", reopen_duration: "1d" }, undefined, []],
  ["jira on global api_url", "jira_configs", { project: "OPS", issue_type: "Bug" }, { jira_api_url: "https://j/x" }, []],
  ["jira with nothing", "jira_configs", {}, undefined, ["PROM209", "PROM209", "PROM209"]],
  ["jira api_type", "jira_configs", { api_url: "https://j/x", project: "OPS", issue_type: "Bug", api_type: "server" }, undefined, ["PROM210"]],
  ["jira Go-only duration", "jira_configs", { api_url: "https://j/x", project: "OPS", issue_type: "Bug", reopen_duration: "1.5h" }, undefined, ["PROM208"]],
  ["mattermost ok", "mattermost_configs", { webhook_url_file: "/m" }, undefined, []],
  ["mattermost on global webhook", "mattermost_configs", {}, { mattermost_webhook_url_file: "/m" }, []],
  ["mattermost without a webhook", "mattermost_configs", {}, undefined, ["PROM209"]],
  ["mattermost field without value", "mattermost_configs", { webhook_url_file: "/m", attachments: [{ fields: [{ title: "a" }] }] }, undefined, ["PROM210"]],
  ["msteams ok", "msteams_configs", { webhook_url_file: "/t" }, undefined, []],
  ["msteams without a webhook", "msteams_configs", {}, undefined, ["PROM209"]],
  ["msteamsv2 ok", "msteamsv2_configs", { webhook_url_file: "/t" }, undefined, []],
  ["msteamsv2 with url and file", "msteamsv2_configs", { webhook_url: "https://t/x", webhook_url_file: "/t" }, undefined, ["PROM210"]],
  ["opsgenie ok", "opsgenie_configs", { api_key_file: "/k", responders: [{ name: "ops", type: "Team" }, { id: "1", type: "{{ .CommonLabels.kind }}" }] }, undefined, []],
  ["opsgenie on global api_key", "opsgenie_configs", {}, { opsgenie_api_key_file: "/k" }, []],
  ["opsgenie without api_key", "opsgenie_configs", {}, undefined, ["PROM209"]],
  ["opsgenie responders", "opsgenie_configs", { api_key_file: "/k", responders: [{ type: "team" }, { name: "x", type: "group" }, { name: "y" }] }, undefined, ["PROM209", "PROM209", "PROM210"]],
  ["pagerduty ok", "pagerduty_configs", { routing_key_file: "/k", url: PD, timeout: "30s" }, undefined, []],
  ["pagerduty without a key", "pagerduty_configs", {}, undefined, ["PROM209"]],
  ["pagerduty key and file", "pagerduty_configs", { service_key: "x", service_key_file: "/k" }, undefined, ["PROM210"]],
  ["pagerduty timeout without unit", "pagerduty_configs", { routing_key_file: "/k", timeout: "10" }, undefined, ["PROM208"]],
  ["pushover ok", "pushover_configs", { user_key_file: "/u", token_file: "/t", retry: "30s", expire: "1h", ttl: "1h30m" }, undefined, []],
  ["pushover without credentials", "pushover_configs", {}, undefined, ["PROM209", "PROM209"]],
  ["pushover html and monospace", "pushover_configs", { user_key_file: "/u", token_file: "/t", html: true, monospace: true }, undefined, ["PROM210"]],
  ["pushover retry in days", "pushover_configs", { user_key_file: "/u", token_file: "/t", retry: "1d" }, undefined, ["PROM208"]],
  ["rocketchat ok", "rocketchat_configs", { token_id_file: "/i", token_file: "/t" }, undefined, []],
  ["rocketchat on global tokens", "rocketchat_configs", {}, { rocketchat_token_id_file: "/i", rocketchat_token_file: "/t" }, []],
  ["rocketchat without tokens", "rocketchat_configs", {}, undefined, ["PROM209", "PROM209"]],
  ["rocketchat token and file", "rocketchat_configs", { token_id_file: "/i", token: "x", token_file: "/t" }, undefined, ["PROM210"]],
  ["slack ok", "slack_configs", { api_url_file: "/s", timeout: "500ms" }, undefined, []],
  ["slack on global app token", "slack_configs", {}, { slack_app_token_file: "/t" }, []],
  ["slack update_message with the app URL", "slack_configs", { api_url: SLACK_APP_URL, update_message: true, http_config: { authorization: { credentials_file: "/t" } } }, undefined, []],
  ["slack without a url or token", "slack_configs", { channel: "#a" }, undefined, ["PROM209"]],
  ["slack local authorization blocks the global token", "slack_configs", { http_config: { authorization: { credentials_file: "/t" } } }, { slack_app_token_file: "/t" }, ["PROM209"]],
  ["slack url and token", "slack_configs", { api_url_file: "/s", app_token_file: "/t" }, undefined, ["PROM210"]],
  ["slack update_message on a webhook", "slack_configs", { api_url_file: "/s", update_message: true }, undefined, ["PROM210"]],
  ["slack app token and authorization", "slack_configs", { app_token_file: "/t", http_config: { bearer_token_file: "/b" } }, undefined, ["PROM210"]],
  ["slack fields and actions", "slack_configs", { api_url_file: "/s", fields: [{ title: "a" }], actions: [{ type: "button", text: "x" }, { type: "button", text: "y", name: "n", confirm: {} }] }, undefined, ["PROM210", "PROM210", "PROM210"]],
  ["slack timeout", "slack_configs", { api_url_file: "/s", timeout: "5 s" }, undefined, ["PROM208"]],
  ["sns ok", "sns_configs", { topic_arn: "arn:aws:sns:x" }, undefined, []],
  ["sns without a target", "sns_configs", {}, undefined, ["PROM209"]],
  ["sns with two targets", "sns_configs", { topic_arn: "arn:aws:sns:x", target_arn: "arn:aws:sns:y" }, undefined, ["PROM210"]],
  ["telegram ok", "telegram_configs", { bot_token_file: "/t", chat_id: 12, parse_mode: "MarkdownV2" }, undefined, []],
  ["telegram on global bot token", "telegram_configs", { chat_id_file: "/c" }, { telegram_bot_token_file: "/t" }, []],
  ["telegram with nothing", "telegram_configs", {}, undefined, ["PROM209", "PROM209"]],
  ["telegram chat_id and file, bad parse_mode", "telegram_configs", { bot_token_file: "/t", chat_id: 12, chat_id_file: "/c", parse_mode: "markdown" }, undefined, ["PROM210", "PROM210"]],
  ["victorops ok", "victorops_configs", { routing_key: "ops", api_key_file: "/k" }, undefined, []],
  ["victorops on global api_key", "victorops_configs", { routing_key: "ops" }, { victorops_api_key_file: "/k" }, []],
  ["victorops with nothing", "victorops_configs", {}, undefined, ["PROM209", "PROM209"]],
  ["victorops reserved custom field", "victorops_configs", { routing_key: "ops", api_key_file: "/k", custom_fields: { entity_id: "x" } }, undefined, ["PROM210"]],
  ["webex ok", "webex_configs", { room_id: "r", http_config: { bearer_token_file: "/t" } }, undefined, []],
  ["webex with nothing", "webex_configs", {}, undefined, ["PROM209", "PROM209"]],
  ["webex with only a global authorization", "webex_configs", { room_id: "r" }, { http_config: { authorization: { credentials_file: "/t" } } }, ["PROM209"]],
  ["webhook ok", "webhook_configs", { url: "http://sink/", timeout: "1m30s" }, undefined, []],
  ["webhook without url", "webhook_configs", {}, undefined, ["PROM209"]],
  ["webhook url and file", "webhook_configs", { url: "http://sink/", url_file: "/u" }, undefined, ["PROM210"]],
  ["webhook timeout in days", "webhook_configs", { url: "http://sink/", timeout: "1d" }, undefined, ["PROM208"]],
  ["wechat ok", "wechat_configs", { api_secret_file: "/s", corp_id: "c", message_type: "markdown" }, undefined, []],
  ["wechat on global secret and corp", "wechat_configs", {}, { wechat_api_secret_file: "/s", wechat_api_corp_id: "c" }, []],
  ["wechat with nothing", "wechat_configs", {}, undefined, ["PROM209", "PROM209"]],
  ["wechat message_type", "wechat_configs", { api_secret_file: "/s", corp_id: "c", message_type: "html" }, undefined, ["PROM210"]],
];

/** An `alertmanager.yml`, as JSON, with one receiver `r` holding `entry` under `key`. */
export const amWith = (key: string, entry: unknown, global?: Record<string, unknown>): string =>
  JSON.stringify({ ...(global ? { global } : {}), route: { receiver: "r" }, receivers: [{ name: "r", [key]: [entry] }] });
