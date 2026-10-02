/**
 * The rules the stack runs. `Watchdog` always fires, so a running stack
 * proves the whole path: Prometheus loaded the rule file, evaluated it, and
 * delivered the alert to Alertmanager, which routed it.
 */
import { RuleGroup, type Rule } from "@intentius/chant-lexicon-prometheus";

const rules: Rule[] = [
  { record: "job:up:sum", expr: "sum by (job) (up)" },
  {
    alert: "Watchdog",
    expr: "vector(1)",
    labels: { severity: "info" },
    annotations: { summary: "Always firing, to show the alerting pipeline works end to end" },
  },
  {
    alert: "TargetDown",
    expr: "up == 0",
    for: "1m",
    labels: { severity: "page" },
    annotations: { summary: "{{ $labels.job }} target {{ $labels.instance }} is down" },
  },
];

const stack = new RuleGroup({ name: "stack", interval: "5s", rules });

export { stack };
