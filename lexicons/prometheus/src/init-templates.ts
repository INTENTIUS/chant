/**
 * `chant init --lexicon prometheus` scaffolds.
 *
 * - default: one rule group and the Alertmanager routing for it, in one build
 *   root so PROM202 checks every severity is routed.
 * - `rules`: rule groups only, for a setup whose Alertmanager config lives
 *   elsewhere.
 * - `slo-style`: a recording rule per window and alerts on two severities,
 *   the shape SLO burn-rate rules take, written out as plain rules.
 * - `slo`: an SLO declared with the `Slo` composite, which builds its error
 *   ratios, error budget and multiwindow burn-rate alerts, and the
 *   Alertmanager routing for the page and ticket severities those alerts
 *   carry, with a page muting the same SLO's ticket.
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

// ── slo ────────────────────────────────────────────────────────────────

const SLO_DECLARATION = `/**
 * The SLO: 99.9% of checkout requests answer without a 5xx over 30 days.
 * \`Slo\` builds one rule group: the error ratio over every window its alerts
 * read, the error budget left, and burn-rate alerts that page on a fast burn
 * (severity "page") and open a ticket on a slow one (severity "ticket").
 * \`sloMetrics(checkout)\` returns the recorded series names, for a dashboard
 * or another rule to read.
 */
import { Slo } from "@intentius/chant-lexicon-prometheus";

const sli = {
  errors: 'sum(rate(http_requests_total{job="checkout",code=~"5.."}[{{window}}]))',
  total: 'sum(rate(http_requests_total{job="checkout"}[{{window}}]))',
};
const team = { team: "payments" };

const checkout = Slo({
  name: "checkout",
  objective: 0.999,
  window: "30d",
  description: "Checkout requests answer without a 5xx.",
  sli,
  labels: team,
});

export { checkout };
`;

const SLO_ALERTMANAGER = `/**
 * Routing for the SLO's alerts, in the same build root so PROM202 checks that
 * both severities they carry have a route.
 */
import { InhibitRule, Receiver, Route, type RouteProps, type WebhookConfig } from "@intentius/chant-lexicon-prometheus";

const pager: WebhookConfig[] = [{ url: "http://pager-bridge:8080/alerts" }];
const oncall = new Receiver({ name: "oncall", webhook_configs: pager });

const ticketing: WebhookConfig[] = [{ url: "http://ticket-bridge:8080/alerts" }];
const tickets = new Receiver({ name: "tickets", webhook_configs: ticketing });

const fallback = new Receiver({ name: "default" });

const bySlo = ["alertname", "slo"];
const children: RouteProps[] = [
  { matchers: ['severity="page"'], receiver: oncall },
  { matchers: ['severity="ticket"'], receiver: tickets },
];
const root = new Route({ receiver: fallback, group_by: bySlo, routes: children });

// A page for an SLO mutes its ticket: the fast burn already has someone on it.
const pageSource = ['severity="page"'];
const ticketTarget = ['severity="ticket"'];
const sameSlo = ["slo"];
const pageMutesTicket = new InhibitRule({ source_matchers: pageSource, target_matchers: ticketTarget, equal: sameSlo });

export { oncall, tickets, fallback, root, pageMutesTicket };
`;

export const DEFAULT_TEMPLATE: InitTemplateSet = { src: { "rules.ts": RULES, "alertmanager.ts": ALERTMANAGER } };

export const RULES_TEMPLATE: InitTemplateSet = { src: { "rules.ts": RULES } };

export const SLO_STYLE_TEMPLATE: InitTemplateSet = { src: { "rules.ts": SLO_STYLE } };

export const SLO_TEMPLATE: InitTemplateSet = { src: { "slo.ts": SLO_DECLARATION, "alertmanager.ts": SLO_ALERTMANAGER } };

/** The template names `chant init --lexicon prometheus --template <name>` takes, besides the default. */
export const TEMPLATE_NAMES = ["rules", "slo-style", "slo"] as const;
