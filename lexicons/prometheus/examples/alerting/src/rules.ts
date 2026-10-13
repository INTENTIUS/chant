/**
 * Alerts at two severities. The same alert name appears twice, once per
 * severity: a fast, high threshold that pages and a slow, low one that files
 * a ticket. Alertmanager (alertmanager.ts) routes each severity.
 */
import { RuleGroup, type Rule, type LabelSet } from "@intentius/chant-lexicon-prometheus";

const team: LabelSet = { team: "payments" };

const rules: Rule[] = [
  {
    record: "service:checkout_errors:ratio5m",
    expr: 'sum(rate(http_requests_total{service="checkout",code=~"5.."}[5m])) / sum(rate(http_requests_total{service="checkout"}[5m]))',
  },
  {
    alert: "CheckoutErrors",
    expr: "service:checkout_errors:ratio5m > 0.1",
    for: "5m",
    labels: { severity: "page" },
    annotations: { summary: "checkout is failing over 10% of requests" },
  },
  {
    alert: "CheckoutErrors",
    expr: "service:checkout_errors:ratio5m > 0.01",
    for: "1h",
    labels: { severity: "ticket" },
    annotations: { summary: "checkout has failed over 1% of requests for an hour" },
  },
  {
    alert: "CheckoutDown",
    expr: 'absent(up{service="checkout"} == 1)',
    for: "2m",
    labels: { severity: "page" },
    annotations: { summary: "no checkout instance is up" },
  },
];

const checkout = new RuleGroup({ name: "checkout", labels: team, rules });

export { checkout };
