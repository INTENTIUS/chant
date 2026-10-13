/**
 * Routing for the stack's two severities. The receivers have no
 * integrations, which is how Alertmanager holds alerts without sending them
 * anywhere: the e2e reads them back from Alertmanager's API.
 */
import { Receiver, Route, type RouteProps } from "@intentius/chant-lexicon-prometheus";

const pager = new Receiver({ name: "pager" });
const heartbeat = new Receiver({ name: "heartbeat" });
const fallback = new Receiver({ name: "default" });

const children: RouteProps[] = [
  { matchers: ['severity="page"'], receiver: pager },
  { matchers: ['severity="info"'], receiver: heartbeat, repeat_interval: "1m" },
];

const byAlert = ["alertname"];

const root = new Route({ receiver: fallback, group_by: byAlert, group_wait: "5s", group_interval: "10s", routes: children });

export { pager, heartbeat, fallback, root };
