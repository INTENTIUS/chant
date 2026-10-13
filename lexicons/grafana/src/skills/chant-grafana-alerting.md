---
skill: chant-grafana-alerting
description: Declare Grafana-managed alert rules, server-side expressions, contact points, notification policies and mute timings with chant, turn an Slo into burn-rate rules, and import Grafana's alerting exports
user-invocable: true
---

# Grafana-managed alerting with chant

Everything is written to `provisioning/alerting/chant.yaml`, Grafana's alerting provisioning file. Mount `dist/grafana/provisioning` at `/etc/grafana/provisioning`.

## A rule

```ts
import { AlertRule, AlertRuleGroup, PromQuery, ReduceExpression, ThresholdExpression } from "@intentius/chant-lexicon-grafana";

const errors = new PromQuery({ datasource: prometheus, expr: 'sum(rate(http_requests_total{code=~"5.."}[5m]))', instant: true });
const last = new ReduceExpression({ expression: "A", reducer: "last" });
const high = new ThresholdExpression({ expression: "B", conditions: [{ evaluator: { type: "gt", params: [5] } }] });
const rule = new AlertRule({ title: "5xx above 5/s", uid: "checkout-5xx", data: [errors, last, high], for: "5m", labels: { severity: "page" } });
export const checkoutAlerts = new AlertRuleGroup({ name: "checkout", folder: "Checkout", interval: "1m", rules: [rule] });
```

- refIds follow `data` order (A, B, C); expressions name inputs by refId (`"A"`, or `$A` in a `MathExpression`). `condition` defaults to the last refId.
- Queries need a `Datasource`, `ExternalDatasource` or `{ type, uid }`; never a `DatasourceVariable`.
- Any plugin's model: `new AlertQuery({ datasource, model: { ... } })`. A typed query with its own range: `new AlertQuery({ query, relativeTimeRange: { from: "5m" } })`.
- Set `uid` explicitly on rules whose title may change.

## Notifications

- `ContactPoint({ name, receivers: [{ type: "slack", settings: { url: "$__env{SLACK_URL}" } }] })`. Secrets always as `$__env{...}` or `$__file{...}`; GRAF002 flags literals.
- `NotificationPolicy({ receiver: oncall, routes: [{ receiver: tickets, object_matchers: [["severity", "=", "ticket"]], mute_time_intervals: [weekends] }] })`. One per organisation: it replaces the whole tree.
- `MuteTiming({ name: "weekends", time_intervals: [{ weekdays: ["saturday", "sunday"] }] })`, `NotificationTemplate({ name, template })`.
- Pass entities rather than names where you can; GRAF113 checks names against what the build declares.

## An SLO's burn-rate alerts

```ts
export const checkoutBurn = SloAlertRules({ slo: checkout, datasource: prometheus, folder: "SLOs" });
```

One rule per window pair, reading the `Slo`'s recorded `slo:sli_error:ratio_rate<window>` series, so the `Slo`'s Prometheus rule group must be loaded. Rules carry `severity: page|ticket` for the policy tree, or pass `contactPoint`.

## Import

`chant import alert-rules.yaml` reads a provisioning file or Grafana's export (`/api/v1/provisioning/alert-rules/export?format=yaml`, and the contact-points, policies and mute-timings exports). Read every warning: guessed datasource types, `[REDACTED]` secrets turned into `$__env{...}`, and delete/reset lists that are not carried.

## Checks

GRAF108 (PromQL), GRAF111 (condition and expression refIds), GRAF112 (datasources), GRAF113 (contact points, mute timings, matchers), GRAF114 (uids, intervals as multiples of 10s, duplicates).
