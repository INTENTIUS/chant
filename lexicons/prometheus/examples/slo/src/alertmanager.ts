/**
 * Routing for the SLOs' alerts, in the same build root so PROM202 checks
 * that both severities they carry (`page` and `ticket`) have a route.
 */
import {
  InhibitRule,
  Receiver,
  Route,
  type PagerDutyConfig,
  type RouteProps,
  type WebhookConfig,
} from "@intentius/chant-lexicon-prometheus";

const pagerduty: PagerDutyConfig[] = [{ routing_key_file: "/etc/alertmanager/secrets/pagerduty-key" }];
const oncall = new Receiver({ name: "oncall", pagerduty_configs: pagerduty });

const bridge: WebhookConfig[] = [{ url: "http://ticket-bridge.monitoring:8080/alerts" }];
const tickets = new Receiver({ name: "tickets", webhook_configs: bridge });

const sink: WebhookConfig[] = [{ url: "http://alert-sink.monitoring:8080/" }];
const fallback = new Receiver({ name: "default", webhook_configs: sink });

const bySlo = ["alertname", "slo"];
const children: RouteProps[] = [
  { matchers: ['severity="page"'], receiver: oncall },
  { matchers: ['severity="ticket"'], receiver: tickets },
];
const root = new Route({ receiver: fallback, group_by: bySlo, routes: children });

// A page for an SLO mutes its tickets: the fast burn already has someone on it.
const pageSource = ['severity="page"'];
const ticketTarget = ['severity="ticket"'];
const sameSlo = ["slo"];
const pageMutesTicket = new InhibitRule({ source_matchers: pageSource, target_matchers: ticketTarget, equal: sameSlo });

export { oncall, tickets, fallback, root, pageMutesTicket };
