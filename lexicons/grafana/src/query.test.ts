/**
 * The query classes beyond Prometheus, Tempo and Loki (#2951): each renders
 * as a target of its plugin, GRAF107 checks the schema-typed ones, the
 * PostgreSQL class answers to the plugin's old id, and GRAF108 still parses
 * only what reaches a Prometheus.
 */
import { describe, expect, test } from "vitest";
import { Dashboard } from "./dashboard";
import { Datasource } from "./datasource";
import { LogsPanel, TablePanel, TimeSeriesPanel } from "./panels";
import {
  AzureMonitorQuery,
  BigQueryQuery,
  CloudMonitoringQuery,
  CloudWatchQuery,
  ElasticsearchQuery,
  LokiQuery,
  MSSQLQuery,
  MySQLQuery,
  PostgresQuery,
  PromQuery,
  PyroscopeQuery,
  OpenSearchQuery,
  queryDefinitionFor,
  registeredQueries,
} from "./query";
import { renderDashboard } from "./build";
import { validateDashboardSchema } from "./schema-validate";
import { prometheusQueries } from "./promql-check";
import { knownDatasources } from "./datasource-refs";
import { SCHEMA_NAMES } from "./pin";

type Json = Record<string, unknown>;

const es = new Datasource({ name: "Logs", type: "elasticsearch" });
const cw = new Datasource({ name: "CloudWatch", type: "cloudwatch" });
const az = new Datasource({ name: "Azure", type: "grafana-azure-monitor-datasource" });
const gcm = new Datasource({ name: "GCM", type: "stackdriver" });
const bq = new Datasource({ name: "BigQuery", type: "grafana-bigquery-datasource" });
const py = new Datasource({ name: "Pyroscope", type: "grafana-pyroscope-datasource" });
const os = new Datasource({ name: "OpenSearch", type: "grafana-opensearch-datasource" });
const pg = new Datasource({ name: "Postgres", type: "grafana-postgresql-datasource" });
const pgOld = new Datasource({ name: "Postgres old", type: "postgres" });
const my = new Datasource({ name: "MySQL", type: "mysql" });
const ms = new Datasource({ name: "MSSQL", type: "mssql" });
const prom = new Datasource({ name: "Prometheus", type: "prometheus" });
const loki = new Datasource({ name: "Loki", type: "loki" });

function render(panels: unknown[]): Json {
  return renderDashboard(new Dashboard({ title: "Q", uid: "q", panels: panels as never })) as unknown as Json;
}

const targetsOf = (json: Json, i = 0) => ((json.panels as Json[])[i].targets as Json[]);

describe("query classes", () => {
  test("every query schema at the pin has a class, and every class names a schema or is hand-typed", () => {
    const schemas = registeredQueries().filter((d) => d.builtin).flatMap((d) => (d.schema ? [d.schema] : []));
    expect(schemas.sort()).toEqual(
      ["prometheus", "tempo", "loki", "elasticsearch", "cloudwatch", "azuremonitor", "googlecloudmonitoring", "bigquery", "grafanapyroscope"].sort(),
    );
    expect(schemas.every((s) => (SCHEMA_NAMES as readonly string[]).includes(s))).toBe(true);
    expect(registeredQueries().filter((d) => d.builtin && !d.schema).map((d) => d.className).sort()).toEqual(["MSSQLQuery", "MySQLQuery", "OpenSearchQuery", "PostgresQuery"]);
  });

  test("each renders as a target of its plugin and passes GRAF107", () => {
    const json = render([
      new TimeSeriesPanel({
        datasource: es,
        targets: [
          new ElasticsearchQuery({
            query: "level:error",
            timeField: "@timestamp",
            metrics: [{ id: "1", type: "count" }],
            bucketAggs: [{ id: "2", type: "date_histogram", field: "@timestamp", settings: { interval: "auto" } }],
          }),
        ],
      }),
      new TimeSeriesPanel({
        datasource: cw,
        targets: [
          new CloudWatchQuery({ queryMode: "Metrics", namespace: "AWS/Lambda", metricName: "Errors", statistic: "Sum", dimensions: { FunctionName: "checkout" } }),
          new CloudWatchQuery({ queryMode: "Logs", expression: "fields @message | limit 20", logGroups: [{ arn: "arn:aws:logs:x", name: "/x" }] }),
        ],
      }),
      new TablePanel({
        datasource: az,
        targets: [new AzureMonitorQuery({ queryType: "Azure Log Analytics", azureLogAnalytics: { query: "AppRequests | take 10", resources: ["/subscriptions/x"] } })],
      }),
      new TimeSeriesPanel({
        datasource: gcm,
        targets: [new CloudMonitoringQuery({ queryType: "promQL", promQLQuery: { projectName: "p", expr: "up", step: "10s" } })],
      }),
      new TablePanel({ datasource: bq, targets: [new BigQueryQuery({ rawSql: "SELECT 1", project: "p" })] }),
      new TimeSeriesPanel({ datasource: py, targets: [new PyroscopeQuery({ profileTypeId: "process_cpu:cpu:nanoseconds:cpu:nanoseconds", queryType: "metrics" })] }),
      new LogsPanel({
        datasource: os,
        targets: [
          new OpenSearchQuery({ query: "level:error", queryType: "lucene", luceneQueryType: "Logs", timeField: "@timestamp", metrics: [{ id: "1", type: "logs" }] }),
          new OpenSearchQuery({ query: "source = logs | head 10", queryType: "PPL", format: "table" }),
        ],
      }),
      new TablePanel({ datasource: pg, targets: [new PostgresQuery({ rawSql: "SELECT now()", format: "table", editorMode: "code", rawQuery: true })] }),
      new TablePanel({ datasource: my, targets: [new MySQLQuery({ rawSql: "SELECT 1" })] }),
      new TablePanel({ datasource: ms, targets: [new MSSQLQuery({ rawSql: "SELECT TOP 1 1" })] }),
    ]);
    const types = (json.panels as Json[]).map((p) => (targetsOf({ panels: [p] })[0].datasource as Json).type);
    expect(types).toEqual([
      "elasticsearch",
      "cloudwatch",
      "grafana-azure-monitor-datasource",
      "stackdriver",
      "grafana-bigquery-datasource",
      "grafana-pyroscope-datasource",
      "grafana-opensearch-datasource",
      "grafana-postgresql-datasource",
      "mysql",
      "mssql",
    ]);
    expect(targetsOf(json, 1).map((t) => t.refId)).toEqual(["A", "B"]);
    expect(targetsOf(json, 6).map((t) => [t.refId, t.queryType])).toEqual([["A", "lucene"], ["B", "PPL"]]);
    expect(validateDashboardSchema(json)).toEqual([]);
  });

  test("GRAF107 checks the schema-typed models: a wrong value is an error, an unknown key a warning", () => {
    const json = render([
      new TimeSeriesPanel({
        datasource: es,
        // @ts-expect-error a bucket aggregation type the schema does not list
        targets: [new ElasticsearchQuery({ query: "*", bucketAggs: [{ id: "2", type: "histogramz" }] })],
      }),
      new TimeSeriesPanel({
        datasource: cw,
        // @ts-expect-error queryMode is Metrics, Logs or Annotations
        targets: [new CloudWatchQuery({ queryMode: "Traces", namespace: "x" })],
      }),
      new TablePanel({
        datasource: bq,
        // @ts-expect-error BigQuery's query has no expr
        targets: [new BigQueryQuery({ rawSql: "SELECT 1", expr: "x" })],
      }),
    ]);
    const problems = validateDashboardSchema(json);
    expect(problems.filter((p) => p.path.startsWith("/panels/0/targets/0/bucketAggs")).some((p) => p.severity === "error")).toBe(true);
    expect(problems.some((p) => p.path.startsWith("/panels/1/targets/0") && p.severity === "error")).toBe(true);
    expect(problems).toContainEqual({ path: "/panels/2/targets/0", message: 'unknown key "expr" (not in the pinned schema)', severity: "warning" });
  });

  test("a query only takes a datasource of its own plugin type", () => {
    // @ts-expect-error a MySQL query cannot go to a Postgres datasource
    new MySQLQuery({ rawSql: "SELECT 1", datasource: pg });
    // @ts-expect-error nor an Elasticsearch query to Loki
    new ElasticsearchQuery({ query: "*", datasource: loki });
    expect(new PostgresQuery({ rawSql: "SELECT 1", datasource: pgOld }).props.datasource).toBe(pgOld);
  });

  test("the PostgreSQL class answers to the plugin's old id, postgres", () => {
    expect(queryDefinitionFor("postgres")?.className).toBe("PostgresQuery");
    expect(queryDefinitionFor("grafana-postgresql-datasource")?.className).toBe("PostgresQuery");
    expect(registeredQueries().filter((d) => d.className === "PostgresQuery")).toHaveLength(1);
  });
});

describe("GRAF108 routing with the new query types", () => {
  test("only queries that reach a Prometheus are parsed, whatever field holds PromQL-looking text", () => {
    const json = render([
      new TimeSeriesPanel({ datasource: prom, targets: [new PromQuery({ expr: "sum(rate(x[5m]))" })] }),
      new TimeSeriesPanel({ datasource: gcm, targets: [new CloudMonitoringQuery({ queryType: "promQL", promQLQuery: { projectName: "p", expr: "sum(", step: "1m" } })] }),
      new TimeSeriesPanel({ datasource: loki, targets: [new LokiQuery({ expr: 'sum(rate({job="x"}[5m]' })] }),
      new TablePanel({ datasource: pg, targets: [new PostgresQuery({ rawSql: "SELECT sum(" })] }),
      new TimeSeriesPanel({ datasource: cw, targets: [new CloudWatchQuery({ queryMode: "Metrics", namespace: "", expression: "SUM(METRICS(" })] }),
    ]);
    const known = knownDatasources(
      [prom, gcm, loki, pg, cw].map((d) => ({ name: d.props.name, type: d.datasourceType, uid: d.uid })),
    );
    expect(prometheusQueries(json, known).map((q) => q.expr)).toEqual(["sum(rate(x[5m]))"]);
  });
});
