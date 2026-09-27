/**
 * `chant init --lexicon prometheus` scaffolds.
 *
 * - default: one rule group and the Alertmanager routing for it, in one build
 *   root so PROM202 checks every severity is routed.
 * - `rules`: rule groups only, for a setup whose Alertmanager config lives
 *   elsewhere.
 * - `slo-style`: a recording rule per window and alerts on two severities,
 *   the shape SLO burn-rate rules take.
 */
import type { InitTemplateSet } from "@intentius/chant/lexicon";

const RULES = `import { RuleGroup, type Rule } from "@intentius/chant-lexicon-prometheus";

const rules: Rule[] = [
  {
    record: "job:http_errors:ratio5m",
    expr: 'sum by (job) (rate(http_requests_total{code=~"5.."}[5m])) / sum by (job) (rate(http_requests_total[5m]))',
  },
  {
    alert: "HttpErrorRatioHigh",
    expr: "job:http_errors:ratio5m > 0.05",
    for: "10m",
    labels: { severity: "page" },
    annotations: { summary: "{{ $labels.job }} is failing over 5% of requests" },
  },
];

const api = new RuleGroup({ name: "api", interval: "30s", rules });

export { api };
`;

const ALERTMANAGER = `import { Receiver, Route, type RouteProps, type WebhookConfig } from "@intentius/chant-lexicon-prometheus";

const hook: WebhookConfig[] = [{ url: "http://alert-sink:8080/" }];
const oncall = new Receiver({ name: "oncall", webhook_configs: hook });
const fallback = new Receiver({ name: "default" });

const children: RouteProps[] = [{ matchers: ['severity="page"'], receiver: oncall }];
const byAlert = ["alertname", "job"];
const root = new Route({ receiver: fallback, group_by: byAlert, routes: children });

export { oncall, fallback, root };
`;

const SLO_STYLE = `import { RuleGroup, type Rule } from "@intentius/chant-lexicon-prometheus";

// Error ratio over two windows, and an alert that needs both to agree.
const windows = ["5m", "1h"];

const recording: Rule[] = windows.map((w) => ({
  record: \`job:http_errors:ratio\${w}\`,
  expr: \`sum by (job) (rate(http_requests_total{code=~"5.."}[\${w}])) / sum by (job) (rate(http_requests_total[\${w}]))\`,
}));

const alerting: Rule[] = [
  {
    alert: "ErrorBudgetBurn",
    expr: "job:http_errors:ratio1h > (14.4 * 0.001) and job:http_errors:ratio5m > (14.4 * 0.001)",
    labels: { severity: "page" },
    annotations: { summary: "{{ $labels.job }} is burning its error budget 14.4x too fast" },
  },
];

const errorRatios = new RuleGroup({ name: "error-ratios", rules: recording });
const burnAlerts = new RuleGroup({ name: "burn-alerts", rules: alerting });

export { errorRatios, burnAlerts };
`;

export function initTemplates(template?: string): InitTemplateSet {
  if (template === "rules") return { src: { "rules.ts": RULES } };
  if (template === "slo-style") return { src: { "rules.ts": SLO_STYLE } };
  return { src: { "rules.ts": RULES, "alertmanager.ts": ALERTMANAGER } };
}
