/**
 * Two SLOs over OpenTelemetry span metrics, each built to its rule group:
 * error ratios per window, the error budget left, and burn-rate alerts that
 * page on fast burns and open tickets on slow ones.
 *
 * `sloMetrics(orderAck)` returns the recorded series names and thresholds, so
 * a dashboard reads them from here rather than repeating them.
 */
import { Slo } from "@intentius/chant-lexicon-prometheus";

const calls = "traces_span_metrics_calls_total";

/** 99.5% of order acknowledgements succeed, over 28 days. */
export const orderAck = Slo({
  name: "order-acknowledged",
  objective: 0.995,
  window: "28d",
  description: "Orders are acknowledged without an error span.",
  sli: {
    good: `sum(rate(${calls}{span_name="order.ack",status_code!="STATUS_CODE_ERROR"}[{{window}}]))`,
    total: `sum(rate(${calls}{span_name="order.ack"}[{{window}}]))`,
  },
  alerting: {
    page: { burnRates: "default", annotations: { runbook_url: "https://runbooks.example.com/order-ack" } },
    ticket: { burnRates: "default" },
  },
  labels: { team: "orders" },
});

/** 99.9% of checkout calls succeed, over 30 days: the Workbook's own factors. */
export const checkout = Slo({
  name: "checkout",
  objective: 0.999,
  window: "30d",
  sli: {
    errors: `sum(rate(${calls}{span_name="checkout",status_code="STATUS_CODE_ERROR"}[{{window}}]))`,
    total: `sum(rate(${calls}{span_name="checkout"}[{{window}}]))`,
  },
  labels: { team: "payments" },
});
