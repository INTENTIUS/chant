/**
 * Routing for the SLO's alerts, in the same build root as the SLO so PROM202
 * checks that both severities it raises have a route.
 *
 * The receivers have no integrations: Alertmanager holds the alerts without
 * sending them anywhere, which is what a cluster with no external account
 * can do, and the e2e reads them back from Alertmanager's API. A real setup
 * adds `pagerduty_configs` or `webhook_configs` here and nothing else moves.
 */
import { InhibitRule, Receiver, Route, type RouteProps } from "@intentius/chant-lexicon-prometheus";

const oncall = new Receiver({ name: "oncall" });
const tickets = new Receiver({ name: "tickets" });
const fallback = new Receiver({ name: "default" });

const bySlo = ["alertname", "slo"];
const children: RouteProps[] = [
  { matchers: ['severity="page"'], receiver: oncall, repeat_interval: "1h" },
  { matchers: ['severity="ticket"'], receiver: tickets, repeat_interval: "12h" },
];
const root = new Route({ receiver: fallback, group_by: bySlo, group_wait: "10s", group_interval: "1m", routes: children });

// A page for an SLO mutes its tickets: the fast burn already has someone on it.
const pageSource = ['severity="page"'];
const ticketTarget = ['severity="ticket"'];
const sameSlo = ["slo"];
const pageMutesTicket = new InhibitRule({ source_matchers: pageSource, target_matchers: ticketTarget, equal: sameSlo });

export { oncall, tickets, fallback, root, pageMutesTicket };
