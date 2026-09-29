---
skill: chant-grafana
description: Declare Grafana dashboards, panels, typed Prometheus/Tempo/Loki queries and datasources as chant entities, and build dashboard JSON Grafana imports as it is
user-invocable: true
---

# Grafana dashboards with chant

The grafana lexicon (`@intentius/chant-lexicon-grafana`) types what a dashboard shows: datasources, dashboards, rows, panels, queries and variables. Grafana server settings, users and plugins are out of scope. `chant build` writes one JSON file per dashboard plus Grafana's provisioning files.

## Project setup

```ts
// chant.config.ts
export default { lexicons: ["grafana"] };
```

## Datasources, declared once

```ts
import { Datasource } from "@intentius/chant-lexicon-grafana";

const prometheus = new Datasource({ name: "Prometheus", type: "prometheus", url: "http://prometheus:9090", isDefault: true });
const tempo = new Datasource({ name: "Tempo", type: "tempo", url: "http://tempo:3200" });

export { prometheus, tempo };
```

The uid defaults to the name as a uid (`prometheus`, `tempo`). Secrets go in `secureJsonData` as `"$__env{NAME}"` or `"$__file{/path}"`, never literally (GRAF002). A declared `Datasource` inside `jsonData` is written as its uid, which is how a Tempo datasource links to Loki or Prometheus.

## Queries

`PromQuery` (PromQL in `expr`), `TempoQuery` (TraceQL in `query`) and `LokiQuery` (LogQL in `expr`). Fields are typed from Grafana's own query schemas. `datasource` only accepts a datasource of the query's plugin type, so a PromQL query can't be pointed at Tempo.

```ts
const requestRate = new PromQuery({
  expr: 'sum by (service) (rate(http_server_request_duration_seconds_count{service="$service"}[$__rate_interval]))',
  legendFormat: "{{service}}",
});
```

## Panels and dashboards

Panel classes: `TimeSeriesPanel`, `StatPanel`, `GaugePanel`, `TablePanel`, `LogsPanel`, `TracesPanel`, `HeatmapPanel`, `TextPanel`, plus `Row`. `options` and `fieldConfig.defaults.custom` are typed from each panel's schema, and every option is optional because Grafana fills in the rest.

```ts
const rate = new TimeSeriesPanel({ title: "Request rate", datasource: prometheus, targets: [requestRate] });
const traces = new TablePanel({ title: "Slow traces", datasource: tempo, targets: [slowTraces] });
const service = new QueryVariable({ name: "service", datasource: prometheus, query: "label_values(up, service)" });

export const overview = new Dashboard({
  title: "Service overview",
  variables: [service],
  panels: [rate, traces],
});
```

Leave `gridPos` out and panels are placed left to right, wrapping at 24 columns; give `x` and `y` to place one exactly. `Row({ title, panels, collapsed })` starts a full-width row. Dashboard uids default to the export name as a uid (`overview`).

chant's lint wants flat declarations: extract nested objects (`time`, `options`) to named consts, keep at most eight declarations per file, and export entities with `export { a, b }`.

## Dashboards built from other declarations

Three composites build a whole dashboard from what another lexicon declares, reading metric names at build time so a rename at the source moves the queries:

```ts
import { Datasource, RedDashboard, SloDashboard, AgentDashboard } from "@intentius/chant-lexicon-grafana";
import { spans, genai } from "./collector";   // an otel SpanMetricsConnector and genAiComponents(...)
import { checkout } from "./slo";            // a prometheus Slo(...)

const services = RedDashboard({ spanMetrics: spans, datasource: prometheus });     // rate, errors, p50/p95/p99 per service
const checkoutSlo = SloDashboard({ slo: checkout, datasource: prometheus });      // SLI, budget left, burn rate per alert window
const agents = AgentDashboard({ genAi: genai, datasource: prometheus });          // per model and tool, tokens per model

export { services, checkoutSlo, agents };
```

Pass the `prometheus` exporter as `exporter` to `RedDashboard` when its `namespace` changes the names. `RedDashboard` counts server and consumer spans only; pass `spanKinds` to count others, or `[]` for every kind. `datasource` may be a `{ type: "prometheus", uid }` ref to a datasource declared elsewhere. Never hand-write the span-metric or SLO series names in a query next to these; use `spanMetricsNames()` (otel), `sloMetrics()` (prometheus) or `genAiMetrics()` (otel), or the composites' `redQueries`, `sloQueries` and `agentQueries`.

## Rules

- GRAF101: every panel, query and query variable names a declared datasource. GRAF102: of the right type.
- GRAF103: every `$name`/`${name}` in a query, title or repeat is a declared variable (`$__*` are Grafana's own).
- GRAF104: unique dashboard uids, datasource uids and names, panel ids, variable names and refIds.
- GRAF105: panels fit the 24-column grid and don't overlap.
- GRAF106: uids of 1-40 letters, digits, `-`, `_`; dashboards have titles.
- GRAF107: the dashboard matches Grafana's schema at the pinned version.

GRAF101 and GRAF102 compare against the datasources in the same build root, so keep datasources and dashboards in one `chant build` (chant #1939).

## Other plugins

`definePanel<Options, Custom>()({ type, className, defaultSize })` adds a panel plugin chant doesn't ship, and `defineQuery<Model>()({ datasourceType, className })` a datasource's query class. Both serialize and lint like the built-ins.
