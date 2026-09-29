/**
 * Where alerts go: two contact points, a policy tree that pages on
 * `severity=page` and files tickets for the rest outside weekends, and the
 * template the email uses. Secrets come from the environment Grafana runs
 * in, never from this file (GRAF002).
 */
import { ContactPoint, MuteTiming, NotificationPolicy, NotificationTemplate } from "@intentius/chant-lexicon-grafana";

const emailTemplate = new NotificationTemplate({
  name: "checkout.email",
  template: '{{ define "checkout.email.subject" }}{{ len .Alerts.Firing }} firing: {{ .CommonLabels.alertname }}{{ end }}',
});

const weekendIntervals: ConstructorParameters<typeof MuteTiming>[0]["time_intervals"] = [
  { weekdays: ["saturday", "sunday"], location: "Europe/Berlin" },
];
const weekends = new MuteTiming({ name: "weekends", time_intervals: weekendIntervals });

const oncallReceivers: ConstructorParameters<typeof ContactPoint>[0]["receivers"] = [
  { type: "slack", settings: { url: "$__env{SLACK_ONCALL_WEBHOOK}", recipient: "#checkout-oncall" } },
  { type: "email", settings: { addresses: "oncall@example.com", subject: '{{ template "checkout.email.subject" . }}' } },
];
const oncall = new ContactPoint({ name: "oncall", receivers: oncallReceivers });

const ticketReceivers: ConstructorParameters<typeof ContactPoint>[0]["receivers"] = [
  { type: "webhook", settings: { url: "https://tickets.example.com/hooks/grafana", authorization_credentials: "$__env{TICKETS_TOKEN}" } },
];
const tickets = new ContactPoint({ name: "tickets", receivers: ticketReceivers });

const policyGroupBy = ["grafana_folder", "alertname", "slo"];
const policyRoutes: ConstructorParameters<typeof NotificationPolicy>[0]["routes"] = [
  { receiver: oncall, object_matchers: [["severity", "=", "page"]], group_wait: "10s" },
  { receiver: tickets, object_matchers: [["severity", "!=", "page"]], mute_time_intervals: [weekends] },
];
const policy = new NotificationPolicy({ receiver: tickets, group_by: policyGroupBy, repeat_interval: "4h", routes: policyRoutes });

export { emailTemplate, weekends, oncall, tickets, policy };
