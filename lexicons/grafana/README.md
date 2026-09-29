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
| panels | `TimeSeriesPanel`, `StatPanel`, `GaugePanel`, `TablePanel`, `LogsPanel`, `TracesPanel`, `HeatmapPanel`, `TextPanel`, `BarChartPanel`, `BarGaugePanel`, `PieChartPanel`, `StateTimelinePanel`, `StatusHistoryPanel`, `HistogramPanel`, `NodeGraphPanel`, `XYChartPanel`, `TrendPanel`, `CanvasPanel`, `GeomapPanel`, `FlameGraphPanel`, `AlertListPanel` |
| queries | `PromQuery` (PromQL), `TempoQuery` (TraceQL), `LokiQuery` (LogQL), `ElasticsearchQuery`, `CloudWatchQuery`, `AzureMonitorQuery`, `CloudMonitoringQuery`, `BigQueryQuery`, `PyroscopeQuery`, `PostgresQuery`, `MySQLQuery`, `MSSQLQuery` |
| variables | `QueryVariable`, `CustomVariable`, `IntervalVariable`, `DatasourceVariable`, `ConstantVariable`, `TextboxVariable`, `AdhocVariable`, `GroupByVariable`, `SwitchVariable` |
| datasources | `Datasource`, generic in its plugin type |
| alerting | `AlertRuleGroup`, `AlertRule`, `AlertQuery`, the expressions `ReduceExpression`, `MathExpression`, `ThresholdExpression`, `ResampleExpression`, `ClassicConditionsExpression`, `SqlExpression`, and `ContactPoint`, `NotificationPolicy`, `MuteTiming`, `NotificationTemplate`, written to `provisioning/alerting/chant.yaml` |

Panel options, field config and query fields are generated from Grafana's JSON Schemas as published by `grafana/grafana-foundation-sdk`, vendored in `src/spec/schemas/`, pinned by commit and digest in `GRAFANA_SCHEMA_PIN`, and corrected against Grafana's CUE by a checked-in overlay in `src/spec/overlay/`. They track Grafana 12.4 and 13.x. `definePanel` and `defineQuery` add plugins chant doesn't ship.

## Dashboards from other declarations

`RedDashboard`, `SloDashboard` and `AgentDashboard` build a dashboard from a declaration in another lexicon: rate, errors and duration per service from an otel `SpanMetricsConnector`; SLI, error budget and burn rate per alert window from a prometheus `Slo`; latency, errors and tokens per model and tool from the otel GenAI preset. Metric names are read from the declaration, so renaming a namespace or an SLO moves the panel queries. `SloAlertRules` turns the same `Slo` into Grafana-managed burn-rate alert rules.

```ts
export const services = RedDashboard({ spanMetrics: spans, datasource: prometheus });
export const checkoutSlo = SloDashboard({ slo: checkout, datasource: prometheus });
export const agents = AgentDashboard({ genAi: genAiMetrics(), datasource: prometheus });
```

## Importing existing dashboards

`chant import dashboard.json --output src` turns dashboard JSON exported from Grafana (with or without "Export for sharing externally") into this lexicon's TypeScript, in a directory named after the dashboard's uid: variables, one module per row with its panels and their queries, and the `Dashboard`. Panel ids, positions and refIds are kept, datasources named by uid become `ExternalDatasource`s, and `__inputs` datasources become `DatasourceVariable`s of the same name. A panel or datasource type chant has no class for is declared with `definePanel` or `defineQuery`. What the lexicon cannot express yet (annotations, library panels, ad hoc variables) is printed as a warning. A v2 dashboard is reported and not imported (#2947). `chant build` on the result gives back the same dashboard: the round-trip tests in `src/import/roundtrip.test.ts` hold Grafana 12.4.11 and 13.2.2 UI exports, community dashboards from grafana.com such as Node Exporter Full, and the examples' output to that. Datasource and dashboard provisioning files import too.

## Drift and live export

With `grafana.profiles.<env>` in `chant.config.ts` (a URL, and a service account token named by its environment variable), or `GRAFANA_URL` and `GRAFANA_TOKEN`, `chant lifecycle diff <env> --live` reads each declared dashboard and datasource from Grafana 12.4 or 13.x over `/apis/dashboard.grafana.app` (Grafana 11 over `/api/dashboards/uid`) and reports a dashboard edited in the UI as drift, at the path it was declared under (`panels[0].panels[1].title: Errors → 5xx`). The stored dashboard is read back through the importer, so what the build fills in (ids, grid positions, refIds) and what Grafana adds (the built-in annotation) is not reported. A dashboard is `owned` when one of the project's providers loaded it or its labels carry `app.kubernetes.io/managed-by: chant`. `chant import --from <env>` writes the environment's dashboards and datasources as TypeScript, through the same generator as `chant import`. The e2e in `src/observe.e2e.test.ts` runs both against Grafana 12.4.11 and 13.2.2.

## Checks

GRAF001 and GRAF002 run on source (uid and variable-name syntax, literal secrets). The GRAF1xx checks run after a build: undeclared or mistyped datasources, undeclared variables, duplicate uids and ids, panels off the grid or overlapping, uids Grafana rejects, validation against the pinned dashboard, panel and query schemas (an unknown key is a warning), a PromQL syntax check on every query sent to a Prometheus (GRAF108), dashboard providers that load a dashboard twice or not into its declared folder (GRAF109), a panel or row repeated over a variable that only ever holds one value (GRAF110), and a check that every panel unit is one Grafana knows or a custom `suffix:`/`prefix:`-style unit (GRAF115).

GRAF101 and GRAF102 compare dashboards with the datasources declared in the same build root (chant #1939); keep them together, and declare a datasource that already exists in Grafana with `ExternalDatasource`, which the checks count and the build never provisions.

## Plain-data API

- `buildGrafana(entities)` and `grafanaFiles(entities)` render every file by path, for embedding in another lexicon's output (a ConfigMap, a volume).
- `GrafanaConfigMaps` and `grafanaVolumes` from `@intentius/chant-lexicon-grafana/k8s` deliver dashboards and provisioning to Kubernetes as ConfigMaps labelled for the Grafana Helm chart's sidecar (`grafana_dashboard`, `grafana_datasource`), or mounted into a plain Grafana Deployment.
- `renderDashboard(dashboard)` and `dashboardJson(dashboard)` render one dashboard.
- `validateGrafanaOutput({ dashboards, datasources })` and `validateDashboardSchema(json)` run the checks without a build.
