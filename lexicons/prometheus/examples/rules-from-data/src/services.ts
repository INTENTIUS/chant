/**
 * Rule groups built from data: one group per service, the same recording
 * rules and alerts for each. A rule is a plain object, so a function can
 * produce them, and each group is still a typed, checked `RuleGroup`.
 */
import { RuleGroup, type Rule } from "@intentius/chant-lexicon-prometheus";

interface ServiceSpec {
  name: string;
  /** Page when the 5xx ratio stays above this for 10 minutes. */
  maxErrorRatio: number;
  /** Page when p99 latency stays above this many seconds for 10 minutes. */
  maxP99Seconds: number;
}

const SERVICES: ServiceSpec[] = [
  { name: "orders", maxErrorRatio: 0.02, maxP99Seconds: 0.5 },
  { name: "inventory", maxErrorRatio: 0.05, maxP99Seconds: 1 },
];

function serviceRules(s: ServiceSpec): Rule[] {
  const sel = `service="${s.name}"`;
  return [
    {
      record: "service:http_errors:ratio5m",
      expr: `sum(rate(http_requests_total{${sel},code=~"5.."}[5m])) / sum(rate(http_requests_total{${sel}}[5m]))`,
      labels: { service: s.name },
    },
    {
      record: "service:http_latency_seconds:p99_5m",
      expr: `histogram_quantile(0.99, sum by (le) (rate(http_request_duration_seconds_bucket{${sel}}[5m])))`,
      labels: { service: s.name },
    },
    {
      alert: "ServiceErrorRatioHigh",
      expr: `service:http_errors:ratio5m{${sel}} > ${s.maxErrorRatio}`,
      for: "10m",
      labels: { severity: "page", service: s.name },
      annotations: { summary: `${s.name} 5xx ratio above ${s.maxErrorRatio * 100}%` },
    },
    {
      alert: "ServiceLatencyHigh",
      expr: `service:http_latency_seconds:p99_5m{${sel}} > ${s.maxP99Seconds}`,
      for: "10m",
      labels: { severity: "page", service: s.name },
      annotations: { summary: `${s.name} p99 latency above ${s.maxP99Seconds}s` },
    },
  ];
}

const orders = new RuleGroup({ name: "orders", rules: serviceRules(SERVICES[0]) });
const inventory = new RuleGroup({ name: "inventory", rules: serviceRules(SERVICES[1]) });

export { orders, inventory };
