/**
 * One group of rules for an HTTP API: a recording rule for its 5xx ratio,
 * and an alert on the recorded series.
 *
 * `chant build` writes the rule file Prometheus loads through `rule_files:`.
 * Rules are plain objects typed with the lexicon's `Rule`, kept in a named
 * const so the constructor stays flat.
 */
import { RuleGroup, type Rule } from "@intentius/chant-lexicon-prometheus";

const rules: Rule[] = [
  {
    record: "job:http_requests:rate5m",
    expr: "sum by (job) (rate(http_requests_total[5m]))",
  },
  {
    record: "job:http_errors:ratio5m",
    expr: 'sum by (job) (rate(http_requests_total{code=~"5.."}[5m])) / job:http_requests:rate5m',
  },
  {
    alert: "ApiErrorRatioHigh",
    expr: "job:http_errors:ratio5m > 0.05",
    for: "10m",
    labels: { severity: "page" },
    annotations: {
      summary: "{{ $labels.job }} is failing {{ $value | humanizePercentage }} of requests",
      runbook_url: "https://runbooks.example.com/api-errors",
    },
  },
];

const api = new RuleGroup({ name: "api", interval: "30s", rules });

export { api };
