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

The uid defaults to the name as a uid (`prometheus`, `tempo`). Secrets go in `secureJsonData` as `"$__env{NAME}"` or `"$__file{/path}"`, never literally (GRAF002). `jsonData` and the `secureJsonData` keys are typed per plugin for every plugin with a query class. A declared `Datasource` inside `jsonData` is written as its uid, which is how a Tempo datasource links to Loki or Prometheus and a Prometheus exemplar to Tempo; a link field only takes a datasource of a type Grafana offers there.

## Queries

`PromQuery` (PromQL in `expr`), `TempoQuery` (TraceQL in `query`), `LokiQuery` (LogQL in `expr`), `ElasticsearchQuery`, `CloudWatchQuery`, `AzureMonitorQuery`, `CloudMonitoringQuery`, `BigQueryQuery`, `PyroscopeQuery`, `OpenSearchQuery`, and `PostgresQuery`, `MySQLQuery` and `MSSQLQuery` (SQL in `rawSql`). Fields are typed from Grafana's own query schemas, or by hand for SQL and OpenSearch. `datasource` only accepts a datasource of the query's plugin type, so a PromQL query can't be pointed at Tempo.

```ts
const requestRate = new PromQuery({
  expr: 'sum by (service) (rate(http_server_request_duration_seconds_count{service="$service"}[$__rate_interval]))',
  legendFormat: "{{service}}",
});
```

## Panels and dashboards

Panel classes: `TimeSeriesPanel`, `StatPanel`, `GaugePanel`, `TablePanel`, `LogsPanel`, `TracesPanel`, `HeatmapPanel`, `TextPanel`, `BarChartPanel`, `BarGaugePanel`, `PieChartPanel`, `StateTimelinePanel`, `StatusHistoryPanel`, `HistogramPanel`, `NodeGraphPanel`, `XYChartPanel`, `TrendPanel`, `CanvasPanel`, `GeomapPanel`, `FlameGraphPanel`, `AlertListPanel`, plus `Row`. `options` and `fieldConfig.defaults.custom` are typed from each panel's schema, and every option is optional because Grafana fills in the rest.

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

`transformations` is typed per transformer id, from Grafana v13.2.2's transformers: `transformation("organize", { excludeByName: { Time: true } })` checks the options against that one transformer, and a `{ id, options }` literal works too. Use `customTransformation(id, options)` for a plugin's transformer or options the types don't have.

Leave `gridPos` out and panels are placed left to right, wrapping at 24 columns and flowing around explicitly placed panels; give `x` and `y` to place one exactly. `Row({ title, panels, collapsed })` starts a full-width row. Dashboard uids default to the export name as a uid (`overview`).

Panels, rows, queries and variables are property-kind, so chant's core lint doesn't count them toward the eight-per-file limit (COR009) and lets them carry `fieldConfig` and `options` inline (COR001). The dashboard is a resource: lift its own nested objects (`time`, `links`) into named consts.

## Dashboards built from other declarations

Three composites build a whole dashboard from what another lexicon declares, reading metric names at build time so a rename at the source moves the queries:

```ts
import { Datasource, RedDashboard, SloDashboard, AgentDashboard } from "@intentius/chant-lexicon-grafana";
import { spans, genai } from "./collector";   // an otel SpanMetricsConnector and genAiComponents(...)
import { checkout } from "./slo";            // a prometheus Slo(...)

const services = RedDashboard({ spanMetrics: spans, datasource: prometheus });     // rate, errors, p50/p95/p99 per service
const checkoutSlo = SloDashboard({ slo: checkout, datasource: prometheus });      // SLI, budget left, burn rate per alert window
const agents = AgentDashboard({ genAi: genai, datasource: prometheus });          // per model and tool, tokens per model
const agentCost = AgentDashboard({ rules: genaiRules, datasource: prometheus });  // from a prometheus GenAiRules: per provider, cost per currency, alerts

export { services, checkoutSlo, agents };
```

Pass the `prometheus` exporter as `exporter` to `RedDashboard` when its `namespace` changes the names. `RedDashboard` counts server and consumer spans only; pass `spanKinds` to count others, or `[]` for every kind. `datasource` may be a `{ type: "prometheus", uid }` ref to a datasource declared elsewhere. Never hand-write the span-metric or SLO series names in a query next to these; use `spanMetricsNames()` (otel), `sloMetrics()` (prometheus), `genAiMetrics()` (otel) or `genAiRuleMetrics()` (prometheus), or the composites' `redQueries`, `sloQueries`, `agentQueries` and `agentRuleQueries`. For a `$service` picker on the rules-mode `AgentDashboard`, build the `GenAiRules` with `groupBy: ["service_name"]` or `["job"]`.

## Rules

- GRAF101: every panel, query, and query, ad hoc and group by variable names a declared datasource (`Datasource` or `ExternalDatasource`), and every datasource variable's plugin type has one. GRAF102: of the right type.
- GRAF103: every `$name`/`${name}` in a query, title or repeat is a declared variable (`$__*` are Grafana's own).
- GRAF104: unique dashboard uids, datasource uids and names, panel ids, variable names and refIds.
- GRAF105: panels fit the 24-column grid and don't overlap.
- GRAF106: uids of 1-40 letters, digits, `-`, `_`; dashboards have titles.
- GRAF107: the dashboard matches Grafana's schema at the pinned version.
- GRAF108: every query and query variable sent to a Prometheus parses as PromQL (template variables and `$__` macros are substituted first; an object-form variable query is checked on its `query`).
- GRAF109: the dashboard providers put each dashboard in its declared folder, and no two load the same files.
- GRAF110: a panel or row repeats over a query, custom or datasource variable with `multi` or `includeAll`, or a group by variable; anything else shows it once (warning).
- GRAF115 (warning): every panel unit is a Grafana unit id (`bytes`, `s`, `percent`, `reqps`, ...) or a custom unit (`suffix: cores`, `prefix:$`, `si:mF`, `count:reqs`, `currency:EUR`). Grafana shows anything else as literal text after the value.
- GRAF116: every query, annotation query and query variable stream selector sent to a Loki parses as LogQL, alert rule queries included (template variables substituted as for GRAF108; an error at a variable is not reported).
- GRAF117 (warning): every TraceQL query sent to a Tempo parses. Grafana's TraceQL grammar trails Tempo's, so newer syntax such as `with (sample=true)` is flagged; check it against Tempo before changing a query that runs.
- GRAF111-GRAF114: alert rules, contact points, policies and mute timings; see the chant-grafana-alerting skill.

GRAF101 and GRAF102 compare against the datasources in the same build root, so keep datasources and dashboards in one `chant build` (chant #1939). For a datasource that exists in Grafana but is provisioned elsewhere, declare `new ExternalDatasource({ type: "prometheus", uid: "mimir" })` and use it like a `Datasource`; it is checked against, never provisioned.

## Other plugins

`definePanel<Options, Custom>()({ type, className, defaultSize })` adds a panel plugin chant doesn't ship, and `defineQuery<Model>()({ datasourceType, className })` a datasource's query class. Both serialize and lint like the built-ins.
