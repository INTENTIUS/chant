# @intentius/chant-lexicon-prometheus

Prometheus lexicon for [chant](https://github.com/INTENTIUS/chant): typed recording and alerting rule groups, serialized to the rule file Prometheus loads, and Alertmanager routes, receivers, inhibit rules and time intervals, serialized to `alertmanager.yml`.

```ts
import { RuleGroup, Receiver, Route, type Rule, type RouteProps } from "@intentius/chant-lexicon-prometheus";

const rules: Rule[] = [
  { record: "job:http_errors:ratio5m", expr: 'sum by (job) (rate(http_requests_total{code=~"5.."}[5m])) / sum by (job) (rate(http_requests_total[5m]))' },
  { alert: "ApiErrors", expr: "job:http_errors:ratio5m > 0.05", for: "10m", labels: { severity: "page" }, annotations: { summary: "5xx above 5%" } },
];
const api = new RuleGroup({ name: "api", rules });

const oncall = new Receiver({ name: "oncall", pagerduty_configs: [{ routing_key_file: "/etc/alertmanager/pd-key" }] });
const fallback = new Receiver({ name: "default" });
const children: RouteProps[] = [{ matchers: ['severity="page"'], receiver: oncall }];
const root = new Route({ receiver: fallback, routes: children });

export { api, oncall, fallback, root };
```

`chant build src --lexicon prometheus -o dist/rules.yml` writes `dist/rules.yml` and `dist/alertmanager.yml`.

## Entities

| Class | File |
|---|---|
| `RuleGroup` | rule file |
| `Route`, `Receiver` (webhook, email, Slack, PagerDuty), `InhibitRule`, `TimeInterval`, `AlertmanagerSettings` | `alertmanager.yml` |

Types follow Prometheus `v3.15.0` and Alertmanager `v0.34.1` (`PROMETHEUS_PIN`).

## Checks

PROM001 and PROM002 run on source (literal credentials, PromQL syntax in literals). PROM101 to PROM107 run over the built rule file: unique group names, duplicate rules, durations, PromQL syntax, rule shape, severity labels and summaries. PROM201 to PROM209 run over `alertmanager.yml`: receivers and time intervals that exist, every alert severity routed (PROM202, one build root at a time), root route shape, matcher syntax, unused receivers, durations and integrations without a destination.

PromQL is parsed with `@prometheus-io/lezer-promql`, the Prometheus project's own grammar. `promtoolCheckRules` and `amtoolCheckConfig` run the upstream tools when they are installed.

## Plain-data API

- `ruleGroupConfig(group)`, `ruleFileYaml(entities)`, `alertmanagerYaml(entities)` render the files inside another lexicon. The k8s lexicon's `PrometheusRule` and `MonitoredService` take `RuleGroup`s through the first.
- `validateRuleFile`, `validateAlertmanagerConfig`, `validateSeverityRouting` run the checks without a build.
- `checkPromql`, `parseMatchers`, `isValidDuration` are the pieces underneath.

## Project structure

- `src/model.ts`: the plain-data shapes of both files
- `src/rules.ts`: `RuleGroup`
- `src/alertmanager.ts`: the Alertmanager entities
- `src/build.ts`: entities to config to YAML
- `src/promql.ts`, `src/matchers.ts`, `src/duration.ts`: parsing
- `src/validate-config.ts`, `src/lint/`: checks
- `src/tools.ts`: promtool and amtool
- `examples/`: getting-started, alerting, rules-from-data, k3d-stack
