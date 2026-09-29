/**
 * An SLO on checkout requests, and its burn-rate alerts as Grafana-managed
 * rules. The Prometheus rule group records the error ratios; the Grafana
 * rules read them, with the windows and thresholds `sloMetrics()` gives.
 */
import { Slo } from "@intentius/chant-lexicon-prometheus";
import { SloAlertRules } from "@intentius/chant-lexicon-grafana";
import { prometheus } from "./datasources";

const checkout = Slo({
  name: "checkout",
  objective: 0.999,
  window: "30d",
  description: "Checkout requests answer without a 5xx.",
  sli: {
    errors: 'sum(rate(http_requests_total{job="checkout",code=~"5.."}[{{window}}]))',
    total: 'sum(rate(http_requests_total{job="checkout"}[{{window}}]))',
  },
  labels: { team: "payments" },
});

const checkoutBurn = SloAlertRules({
  slo: checkout,
  datasource: prometheus,
  folder: "SLOs",
  labels: { team: "payments" },
  annotations: { runbook_url: "https://runbooks.example.com/checkout-slo" },
});

export { checkout, checkoutBurn };
