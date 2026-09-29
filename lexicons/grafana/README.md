# @intentius/chant-lexicon-grafana

Grafana lexicon for [chant](https://github.com/INTENTIUS/chant): typed dashboards, panels, queries, variables and datasources, built to the dashboard JSON Grafana imports as it is and to Grafana's provisioning files.

```ts
import { Datasource, PromQuery, TimeSeriesPanel, Dashboard } from "@intentius/chant-lexicon-grafana";

const prometheus = new Datasource({ name: "Prometheus", type: "prometheus", url: "http://prometheus:9090" });
const rate = new PromQuery({ expr: "sum(rate(http_requests_total[$__rate_interval]))" });
const requests = new TimeSeriesPanel({ title: "Requests per second", datasource: prometheus, targets: [rate] });
const overview = new Dashboard({ title: "Overview", panels: [requests] });

export { prometheus, rate, requests, overview };
```

`chant build src --lexicon grafana -o dist/grafana/index.json` writes `dashboards/overview.json`, `provisioning/datasources/chant.yaml` and `provisioning/dashboards/chant.yaml`.

## What it types

| Kind | Classes |
|---|---|
| dashboards | `Dashboard`, `Row`, `DashboardProvider` |
| panels | `TimeSeriesPanel`, `StatPanel`, `GaugePanel`, `TablePanel`, `LogsPanel`, `TracesPanel`, `HeatmapPanel`, `TextPanel` |
| queries | `PromQuery` (PromQL), `TempoQuery` (TraceQL), `LokiQuery` (LogQL) |
| variables | `QueryVariable`, `CustomVariable`, `IntervalVariable`, `DatasourceVariable`, `ConstantVariable`, `TextboxVariable` |
| datasources | `Datasource`, generic in its plugin type |

Panel options, field config and query fields are generated from Grafana's JSON Schemas as published by `grafana/grafana-foundation-sdk`, vendored in `src/spec/schemas/`, pinned by commit and digest in `GRAFANA_SCHEMA_PIN`, and corrected against Grafana's CUE by a checked-in overlay in `src/spec/overlay/`. They track Grafana 12.4 and 13.x. `definePanel` and `defineQuery` add plugins chant doesn't ship.

## Dashboards from other declarations

`RedDashboard`, `SloDashboard` and `AgentDashboard` build a dashboard from a declaration in another lexicon: rate, errors and duration per service from an otel `SpanMetricsConnector`; SLI, error budget and burn rate per alert window from a prometheus `Slo`; latency, errors and tokens per model and tool from the otel GenAI preset. Metric names are read from the declaration, so renaming a namespace or an SLO moves the panel queries.

```ts
export const services = RedDashboard({ spanMetrics: spans, datasource: prometheus });
export const checkoutSlo = SloDashboard({ slo: checkout, datasource: prometheus });
export const agents = AgentDashboard({ genAi: genAiMetrics(), datasource: prometheus });
```

## Importing existing dashboards

`chant import dashboard.json --output src` turns dashboard JSON exported from Grafana (with or without "Export for sharing externally") into this lexicon's TypeScript, in a directory named after the dashboard's uid: variables, one module per row with its panels and their queries, and the `Dashboard`. Panel ids, positions and refIds are kept, datasources named by uid become `DatasourceRef` consts, and `__inputs` datasources become `DatasourceVariable`s of the same name. A panel or datasource type chant has no class for is declared with `definePanel` or `defineQuery`. What the lexicon cannot express yet (annotations, library panels, ad hoc variables) is printed as a warning. A v2 dashboard is reported and not imported (#2947). `chant build` on the result gives back the same dashboard: the round-trip tests in `src/import/roundtrip.test.ts` hold Grafana 12.4.11 and 13.2.2 UI exports, community dashboards from grafana.com such as Node Exporter Full, and the examples' output to that. Datasource and dashboard provisioning files import too.

## Checks

GRAF001 and GRAF002 run on source (uid and variable-name syntax, literal secrets). GRAF101 to GRAF107 run after a build: undeclared or mistyped datasources, undeclared variables, duplicate uids and ids, panels off the grid or overlapping, uids Grafana rejects, and validation against the pinned dashboard, panel and query schemas (an unknown key is a warning).

GRAF101 and GRAF102 compare dashboards with the datasources declared in the same build root (chant #1939); keep them together.

## Plain-data API

- `buildGrafana(entities)` and `grafanaFiles(entities)` render every file by path, for embedding in another lexicon's output (a ConfigMap, a volume).
- `renderDashboard(dashboard)` and `dashboardJson(dashboard)` render one dashboard.
- `validateGrafanaOutput({ dashboards, datasources })` and `validateDashboardSchema(json)` run the checks without a build.
