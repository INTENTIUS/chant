/**
 * Alertmanager routing for the rules in rules.ts, declared in the same build
 * root so PROM202 can check that every alert severity has a route.
 *
 * `chant build src -o dist/rules.yml` writes the rule file there and
 * `dist/alertmanager.yml` beside it. Credentials come from mounted files:
 * Alertmanager does not expand environment variables in its config.
 */
import {
  AlertmanagerSettings,
  InhibitRule,
  Receiver,
  Route,
  TimeInterval,
  type AlertmanagerGlobalConfig,
  type EmailConfig,
  type PagerDutyConfig,
  type RouteProps,
  type SlackConfig,
  type TimePeriodConfig,
  type WebhookConfig,
} from "@intentius/chant-lexicon-prometheus";

const global: AlertmanagerGlobalConfig = {
  resolve_timeout: "5m",
  smtp_smarthost: "smtp.example.com:587",
  smtp_from: "alertmanager@example.com",
  smtp_auth_username: "alertmanager",
  smtp_auth_password_file: "/etc/alertmanager/secrets/smtp-password",
};

const settings = new AlertmanagerSettings({ global });

const pagerduty: PagerDutyConfig[] = [{ routing_key_file: "/etc/alertmanager/secrets/pagerduty-key", severity: "critical" }];
const slack: SlackConfig[] = [
  { api_url_file: "/etc/alertmanager/secrets/slack-url", channel: "#payments-alerts", send_resolved: true },
];
const oncall = new Receiver({ name: "payments-oncall", pagerduty_configs: pagerduty, slack_configs: slack });

const email: EmailConfig[] = [{ to: "payments@example.com" }];
const bridge: WebhookConfig[] = [{ url: "http://ticket-bridge.monitoring:8080/alerts", send_resolved: false }];
const tickets = new Receiver({ name: "payments-tickets", email_configs: email, webhook_configs: bridge });

const sink: WebhookConfig[] = [{ url: "http://alert-sink.monitoring:8080/" }];
const fallback = new Receiver({ name: "default", webhook_configs: sink });

const outsideOfficeHours: TimePeriodConfig[] = [
  { weekdays: ["saturday", "sunday"] },
  { weekdays: ["monday:friday"], times: [{ start_time: "00:00", end_time: "09:00" }, { start_time: "18:00", end_time: "24:00" }] },
];
const officeHours = new TimeInterval({ name: "outside-office-hours", time_intervals: outsideOfficeHours });

const byGroup = ["alertname", "service"];
const children: RouteProps[] = [
  { matchers: ['severity="page"'], receiver: oncall, repeat_interval: "1h" },
  { matchers: ['severity="ticket"'], receiver: tickets, mute_time_intervals: [officeHours] },
];

const root = new Route({
  receiver: fallback,
  group_by: byGroup,
  group_wait: "30s",
  group_interval: "5m",
  repeat_interval: "4h",
  routes: children,
});

const pageSource = ['severity="page"'];
const ticketTarget = ['severity="ticket"'];
const sameAlert = ["alertname"];
const pageMutesTicket = new InhibitRule({ source_matchers: pageSource, target_matchers: ticketTarget, equal: sameAlert });

export { settings, oncall, tickets, fallback, officeHours, root, pageMutesTicket };
