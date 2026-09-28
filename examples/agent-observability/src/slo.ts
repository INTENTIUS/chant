/**
 * The agent's SLO: 99% of its runs end without an error span, over 28 days.
 *
 * The SLI reads the RED metrics the gateway's `spanmetrics` connector derives
 * from every span, before sampling, so the SLO counts runs Tempo never sees.
 * The metric and label names come from the connector and exporter
 * declarations through `spanMetricsNames()`, so the SLO, its rules and its
 * dashboard move with them. `Slo` builds the recording rules and the
 * multiwindow burn-rate alerts; `severity` is `page` for fast burns and
 * `ticket` for slow ones, which is what alertmanager.ts routes on.
 */
import { spanMetricsNames } from "@intentius/chant-lexicon-otel";
import { Slo } from "@intentius/chant-lexicon-prometheus";
import { red } from "./gateway-metrics";
import { scrapeEndpoint } from "./gateway-components";

const names = spanMetricsNames(red, scrapeEndpoint);
const calls = names.calls.prometheus;
const runs = `${names.labels.service}="support-agent",${names.labels.spanName}="invoke_agent support"`;
const failed = `${names.labels.statusCode}="${names.errorStatus}"`;

export const agentRuns = Slo({
  name: "support-agent-runs",
  objective: 0.99,
  window: "28d",
  description: "Support agent runs end without an error span.",
  sli: {
    errors: `sum(rate(${calls}{${runs},${failed}}[{{window}}]))`,
    total: `sum(rate(${calls}{${runs}}[{{window}}]))`,
  },
  interval: "15s",
  labels: { team: "agents" },
});
