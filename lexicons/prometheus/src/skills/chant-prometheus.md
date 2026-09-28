---
skill: chant-prometheus
description: Declare Prometheus recording and alerting rule groups as typed chant entities and build a rule file that passes promtool
user-invocable: true
---

# Prometheus rules with chant

The prometheus lexicon (`@intentius/chant-lexicon-prometheus`) types Prometheus rule groups. Each `RuleGroup` is an entity; `chant build` writes the rule file Prometheus loads through `rule_files:`.

## Project setup

```ts
// chant.config.ts
export default { lexicons: ["prometheus"] };
```

## Starting from an existing rule file

When the user already has a rule file, import it rather than retyping it:

```bash
chant import rules.yml --output src          # add --lexicon prometheus outside a chant project
chant build src --lexicon prometheus -o rules.yml   # the same groups back
```

The importer writes `rules.ts` (per group, a `Rule[]` const of plain objects and a `RuleGroup`) and `slos.ts` for any group an `Slo()` built, as the `Slo` call. Multi-line expressions become template literals and Go templates in annotations stay as written. Read the warnings `chant import` prints: they name any field Prometheus doesn't define, which is not carried.

## Declaring a group

A group takes the rule file's own keys (`name`, `interval`, `query_offset`, `limit`, `labels`, `rules`). Rules are plain objects: `record` + `expr` for a recording rule, `alert` + `expr` (+ `for`, `keep_firing_for`, `labels`, `annotations`) for an alerting rule.

```ts
import { RuleGroup } from "@intentius/chant-lexicon-prometheus";

export const api = new RuleGroup({
  name: "api",
  interval: "30s",
  rules: [
    {
      record: "job:http_errors:ratio5m",
      expr: 'sum by (job) (rate(http_requests_total{code=~"5.."}[5m])) / sum by (job) (rate(http_requests_total[5m]))',
    },
    {
      alert: "ApiErrorRatioHigh",
      expr: "job:http_errors:ratio5m > 0.05",
      for: "10m",
      labels: { severity: "page" },
      annotations: { summary: "{{ $labels.job }} 5xx ratio above 5%", runbook_url: "https://runbooks.example.com/api-errors" },
    },
  ],
});
```

Build it with `chant build src --lexicon prometheus -o dist/rules.yml`.

## Rules of thumb

- Name recording rules `level:metric:operations` (`job:http_errors:ratio5m`), and alert on the recorded series rather than repeating the expression.
- Give every alert a `severity` label (PROM106) that an Alertmanager route matches (PROM202), and a `summary` annotation (PROM107).
- Alerts may share a name when their labels differ, e.g. the same alert at `severity: "page"` and `severity: "ticket"`. Two rules with the same name *and* labels overwrite each other (PROM102).
- Durations are Prometheus durations: `30s`, `5m`, `1h30m`. Not `1.5h`, not `90 seconds` (PROM103).
- Every `expr` is parsed with the Prometheus project's PromQL grammar at build time (PROM104) and, for literals, in the editor (PROM002).

## Checking with promtool

```ts
import { ruleFileYaml, promtoolCheckRules } from "@intentius/chant-lexicon-prometheus";

const result = promtoolCheckRules(ruleFileYaml([api]));
if (result.ran && !result.ok) throw new Error(result.output);
```

`ran` is false when `promtool` isn't on PATH (or `$PROMTOOL`), so a test can skip instead of failing.

## Building rules from data

`RuleGroup` takes plain rule objects, so a composite can generate them: map over services or windows, return one or more `RuleGroup`s, and the rule file and a `PrometheusRule` both pick them up. `ruleGroupConfig(group)` gives the plain group as it appears in the file.

## SLOs

`Slo` builds an SLO to one `RuleGroup`: error ratios per window, the error budget left, and the SRE Workbook's multiwindow burn-rate alerts (page at 1h/5m and 6h/30m, ticket at 1d/2h and 3d/6h, factors scaled to the SLO window). It is a composite, called without `new`.

```ts
import { Slo, sloMetrics } from "@intentius/chant-lexicon-prometheus";

export const checkout = Slo({
  name: "checkout",
  objective: 0.999,
  window: "30d",
  sli: {
    good: 'sum(rate(http_requests_total{job="checkout",code!~"5.."}[{{window}}]))',
    total: 'sum(rate(http_requests_total{job="checkout"}[{{window}}]))',
  },
});

sloMetrics(checkout).errorRatio["1h"]; // "slo:sli_error:ratio_rate1h"
```

- Write the objective as a fraction strictly between 0 and 1, and put `{{window}}` where each SLI expression's range goes (PROM003).
- Alerts carry `severity` `page` or `ticket`; route both (PROM202).
- Read series names from `sloMetrics()` in dashboards instead of repeating them.
