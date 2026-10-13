/**
 * An SLO on checkout, written over the span metrics the collector emits.
 * The SLI takes the metric and label names from the connector declaration,
 * so the SLO, its rules and its dashboard move together.
 */
import { spanMetricsNames } from "@intentius/chant-lexicon-otel";
import { Slo } from "@intentius/chant-lexicon-prometheus";
import { spans } from "./components";

const names = spanMetricsNames(spans);
const calls = names.calls.prometheus;
const checkoutSpans = `${names.labels.spanName}="checkout"`;
const failed = `${names.labels.statusCode}="${names.errorStatus}"`;

const checkout = Slo({
  name: "checkout",
  objective: 0.999,
  window: "30d",
  description: "Checkout calls end without an error span.",
  sli: {
    errors: `sum(rate(${calls}{${checkoutSpans},${failed}}[{{window}}]))`,
    total: `sum(rate(${calls}{${checkoutSpans}}[{{window}}]))`,
  },
  labels: { team: "payments" },
});

export { checkout };
