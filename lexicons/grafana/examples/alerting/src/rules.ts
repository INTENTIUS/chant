/**
 * Two rules written by hand: a Prometheus latency rule built from typed
 * server-side expressions (reduce, and a threshold with a recovery
 * threshold), and a Loki rule that pages on panics.
 */
import {
  AlertQuery,
  AlertRule,
  AlertRuleGroup,
  LokiQuery,
  PromQuery,
  ReduceExpression,
  ThresholdExpression,
} from "@intentius/chant-lexicon-grafana";
import { loki, prometheus } from "./datasources";

const p99 = new PromQuery({
  datasource: prometheus,
  expr: 'histogram_quantile(0.99, sum by (le) (rate(http_request_duration_seconds_bucket{job="checkout"}[5m])))',
  range: true,
});
const p99Max = new ReduceExpression({ expression: "A", reducer: "max" });
const p99Threshold = new ThresholdExpression({
  expression: "B",
  conditions: [{ evaluator: { type: "gt", params: [0.5] }, unloadEvaluator: { type: "lt", params: [0.4] } }],
});
const latencyLabels = { severity: "ticket", team: "payments" };
const latency = new AlertRule({
  title: "Checkout p99 latency above 500ms",
  uid: "checkout-p99-latency",
  data: [p99, p99Max, p99Threshold],
  relativeTimeRange: { from: "30m" },
  for: "10m",
  labels: latencyLabels,
  annotations: { summary: "Checkout p99 is {{ humanizeDuration $values.B.Value }}" },
});

const panicsQuery = new LokiQuery({ datasource: loki, expr: 'sum(count_over_time({app="checkout"} |= "panic" [5m]))' });
const panics = new AlertQuery({ query: panicsQuery, queryType: "instant", relativeTimeRange: { from: "5m" } });
const panicsOverZero = new ThresholdExpression({ expression: "A", conditions: [{ evaluator: { type: "gt", params: [0] } }] });
const panicLabels = { severity: "page", team: "payments" };
const panicRule = new AlertRule({
  title: "Checkout panicked",
  uid: "checkout-panics",
  data: [panics, panicsOverZero],
  noDataState: "OK",
  labels: panicLabels,
});

const checkoutAlerts = new AlertRuleGroup({ name: "checkout", folder: "Checkout", interval: "1m", rules: [latency, panicRule] });

export { checkoutAlerts };
