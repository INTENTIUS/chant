/**
 * One SLO over a request counter. `chant build src --lexicon prometheus`
 * writes its rule group, `slo-checkout`, to dist/rules.yml, which is what
 * Prometheus loads and what `ops/rules-loaded.op.ts` observes.
 */
import { Slo } from "@intentius/chant-lexicon-prometheus";

export const checkout = Slo({
  name: "checkout",
  objective: 0.995,
  window: "30d",
  description: "Checkout requests answer without a 5xx.",
  sli: {
    good: 'sum(rate(http_requests_total{job="checkout",code!~"5.."}[{{window}}]))',
    total: 'sum(rate(http_requests_total{job="checkout"}[{{window}}]))',
  },
  labels: { team: "payments" },
});
