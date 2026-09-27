/**
 * The dashboard: variables, a row for the service's rates, errors and
 * latency, and a collapsed row for digging into slow requests.
 */
import { Dashboard, Row } from "@intentius/chant-lexicon-grafana";
import { service, traceId } from "./variables";
import { intro, errors, errorGauge, rate, latency } from "./overview-panels";
import { latencyDistribution, slowest, logs, trace } from "./debug-panels";

const red = new Row({ title: "Rate, errors, duration", panels: [errors, errorGauge, rate, latency] });

const investigate = new Row({ title: "Investigate", collapsed: true, panels: [latencyDistribution, slowest, logs, trace] });

const lastHour = { from: "now-1h", to: "now" };
const docs = { title: "Runbook", type: "link" as const, url: "https://example.com/runbooks/service", targetBlank: true };

const serviceOverview = new Dashboard({
  title: "Service overview",
  uid: "service-overview",
  tags: ["chant", "red"],
  time: lastHour,
  refresh: "30s",
  graphTooltip: "sharedCrosshair",
  variables: [service, traceId],
  panels: [intro, red, investigate],
  links: [docs],
  folder: "Services",
});

export { serviceOverview };
