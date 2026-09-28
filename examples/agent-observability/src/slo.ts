/**
 * The agent's SLO: 99% of its runs end without an error span, over 28 days.
 *
 * The SLI reads the RED metrics the gateway's `spanmetrics` connector derives
 * from every span, before sampling, so the SLO counts runs Tempo never sees.
 * `Slo` builds the recording rules and the multiwindow burn-rate alerts;
 * `severity` is `page` for fast burns and `ticket` for slow ones, which is
 * what alertmanager.ts routes on.
 */
import { Slo } from "@intentius/chant-lexicon-prometheus";

const calls = "traces_span_metrics_calls_total";
const runs = `service_name="support-agent",span_name="invoke_agent support"`;
const failed = `status_code="STATUS_CODE_ERROR"`;

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
