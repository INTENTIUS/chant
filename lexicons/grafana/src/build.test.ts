import { describe, expect, test } from "vitest";
import { Datasource } from "./datasource";
import { Dashboard } from "./dashboard";
import { Row, StatPanel, TextPanel, TimeSeriesPanel, TablePanel, definePanel } from "./panels";
import { PromQuery, TempoQuery, LokiQuery, defineQuery } from "./query";
import {
  CustomVariable,
  ConstantVariable,
  DatasourceVariable,
  IntervalVariable,
  QueryVariable,
  TextboxVariable,
} from "./variables";
import { panelsJson, renderDashboard, variableModel, dashboardJson, grafanaFiles, type PanelJson } from "./build";

/** The panels array, read as plain panels (the tests below build no rows unless they say so). */
function panelsOnly(items: Parameters<typeof panelsJson>[0]): PanelJson[] {
  return panelsJson(items) as PanelJson[];
}
import { validateDashboardSchema } from "./schema-validate";

const prometheus = new Datasource({ name: "Prometheus", type: "prometheus" });
const tempo = new Datasource({ name: "Tempo", type: "tempo" });

describe("layout", () => {
  test("panels flow left to right and wrap at 24 columns", () => {
    const stats = [1, 2, 3, 4, 5].map((i) => new StatPanel({ title: `s${i}` }));
    const panels = panelsJson(stats);
    expect(panels.map((p) => p.gridPos)).toEqual([
      { h: 4, w: 6, x: 0, y: 0 },
      { h: 4, w: 6, x: 6, y: 0 },
      { h: 4, w: 6, x: 12, y: 0 },
      { h: 4, w: 6, x: 18, y: 0 },
      { h: 4, w: 6, x: 0, y: 4 },
    ]);
  });

  test("a new line starts below the tallest panel of the line before", () => {
    const panels = panelsJson([new StatPanel(), new TimeSeriesPanel(), new StatPanel(), new TextPanel()]);
    expect(panels.map((p) => p.gridPos)).toEqual([
      { h: 4, w: 6, x: 0, y: 0 },
      { h: 8, w: 12, x: 6, y: 0 },
      { h: 4, w: 6, x: 18, y: 0 },
      { h: 3, w: 24, x: 0, y: 8 },
    ]);
  });

  test("an explicit position is kept, and w/h without x/y only resize", () => {
    const panels = panelsJson([
      new StatPanel({ gridPos: { x: 12, y: 20, w: 12, h: 2 } }),
      new StatPanel({ gridPos: { w: 24 } }),
    ]);
    expect(panels.map((p) => p.gridPos)).toEqual([
      { h: 2, w: 12, x: 12, y: 20 },
      { h: 4, w: 24, x: 0, y: 0 },
    ]);
  });

  test("rows start below everything and their panels follow; a collapsed row nests them", () => {
    const panels = panelsJson([
      new TimeSeriesPanel({ title: "top" }),
      new Row({ title: "open", panels: [new StatPanel({ title: "a" }), new StatPanel({ title: "b" })] }),
      new Row({ title: "shut", collapsed: true, panels: [new TablePanel({ title: "c" })] }),
      new StatPanel({ title: "after" }),
    ]);
    expect(panels.map((p) => [p.type, p.title, p.gridPos, p.id])).toEqual([
      ["timeseries", "top", { h: 8, w: 12, x: 0, y: 0 }, 1],
      ["row", "open", { h: 1, w: 24, x: 0, y: 8 }, 2],
      ["stat", "a", { h: 4, w: 6, x: 0, y: 9 }, 3],
      ["stat", "b", { h: 4, w: 6, x: 6, y: 9 }, 4],
      ["row", "shut", { h: 1, w: 24, x: 0, y: 13 }, 5],
      ["stat", "after", { h: 4, w: 6, x: 0, y: 14 }, 7],
    ]);
    const shut = panels[4] as unknown as { collapsed: boolean; panels: Array<{ title: string; id: number; gridPos: unknown }> };
    expect(shut.collapsed).toBe(true);
    expect(shut.panels.map((p) => [p.title, p.id, p.gridPos])).toEqual([["c", 6, { h: 8, w: 12, x: 0, y: 14 }]]);
    expect((panels[1] as unknown as { panels: unknown[] }).panels).toEqual([]);
  });

  test("auto ids skip ids set explicitly", () => {
    const panels = panelsJson([new StatPanel(), new StatPanel({ id: 1 }), new StatPanel()]);
    expect(panels.map((p) => p.id)).toEqual([2, 1, 3]);
  });
});

describe("datasources and targets", () => {
  test("refIds default to A, B, C; an explicit refId is kept", () => {
    const [panel] = panelsOnly([
      new TimeSeriesPanel({ datasource: prometheus, targets: [new PromQuery({ expr: "a" }), new PromQuery({ expr: "b", refId: "errors" }), new PromQuery({ expr: "c" })] }),
    ]);
    expect(panel.targets!.map((t) => (t as { refId: string }).refId)).toEqual(["A", "errors", "C"]);
  });

  test("queries on different datasources make the panel Mixed", () => {
    const [panel] = panelsOnly([
      new TablePanel({ targets: [new PromQuery({ expr: "up", datasource: prometheus }), new TempoQuery({ query: "{}", datasource: tempo })] }),
    ]);
    expect(panel.datasource).toEqual({ type: "datasource", uid: "-- Mixed --" });
    expect(panel.targets!.map((t) => (t as { datasource: unknown }).datasource)).toEqual([
      { type: "prometheus", uid: "prometheus" },
      { type: "tempo", uid: "tempo" },
    ]);
  });

  test("a panel takes its queries' shared datasource, and a row passes its own down", () => {
    const [shared] = panelsOnly([new StatPanel({ targets: [new PromQuery({ expr: "up", datasource: prometheus })] })]);
    expect(shared.datasource).toEqual({ type: "prometheus", uid: "prometheus" });
    const [, child] = panelsOnly([new Row({ title: "r", datasource: prometheus, panels: [new StatPanel({ targets: [new PromQuery({ expr: "up" })] })] })]);
    expect((child.targets![0] as { datasource: unknown }).datasource).toEqual({ type: "prometheus", uid: "prometheus" });
  });

  test("a datasource variable is referenced as ${name}; a plain ref passes through", () => {
    const ds = new DatasourceVariable({ name: "ds", pluginType: "prometheus" });
    const [a, b] = panelsOnly([
      new StatPanel({ datasource: ds, targets: [new PromQuery({ expr: "up" })] }),
      new StatPanel({ datasource: { type: "prometheus", uid: "mimir" }, targets: [new PromQuery({ expr: "up" })] }),
    ]);
    expect(a.datasource).toEqual({ type: "prometheus", uid: "${ds}" });
    expect(b.datasource).toEqual({ type: "prometheus", uid: "mimir" });
  });

  test("Tempo queries get the fields the schema requires", () => {
    const [panel] = panelsOnly([new TablePanel({ datasource: tempo, targets: [new TempoQuery({ query: "{ status = error }" })] })]);
    expect(panel.targets![0]).toEqual({ datasource: { type: "tempo", uid: "tempo" }, refId: "A", filters: [], queryType: "traceql", query: "{ status = error }" });
  });

  test("Loki queries carry their expression as expr", () => {
    const loki = new Datasource({ name: "Loki", type: "loki" });
    const [panel] = panelsOnly([new TablePanel({ datasource: loki, targets: [new LokiQuery({ expr: '{app="x"}', maxLines: 100 })] })]);
    expect(panel.targets![0]).toMatchObject({ expr: '{app="x"}', maxLines: 100 });
  });
});

describe("variables", () => {
  test("each kind renders to a VariableModel", () => {
    expect(variableModel(new QueryVariable({ name: "svc", datasource: prometheus, query: "label_values(up, job)", multi: true }))).toEqual({
      type: "query",
      name: "svc",
      datasource: { type: "prometheus", uid: "prometheus" },
      query: "label_values(up, job)",
      definition: "label_values(up, job)",
      refresh: 1,
      multi: true,
      options: [],
    });
    expect(variableModel(new CustomVariable({ name: "env", values: ["prod", "a,b"] }))).toMatchObject({
      type: "custom",
      query: "prod,a\\,b",
      current: { text: "prod", value: "prod" },
      options: [
        { selected: true, text: "prod", value: "prod" },
        { selected: false, text: "a,b", value: "a,b" },
      ],
    });
    expect(variableModel(new IntervalVariable({ name: "step", values: ["1m", "5m"] }))).toMatchObject({ type: "interval", query: "1m,5m", auto: false, refresh: 2 });
    expect(variableModel(new DatasourceVariable({ name: "ds", pluginType: "loki", hide: "valueOnly" }))).toMatchObject({ type: "datasource", query: "loki", hide: 1 });
    expect(variableModel(new ConstantVariable({ name: "cluster", value: "prod-1" }))).toMatchObject({ type: "constant", query: "prod-1", hide: 2 });
    expect(variableModel(new TextboxVariable({ name: "q" }))).toMatchObject({ type: "textbox", query: "" });
  });

  test("a dashboard with every variable kind matches the dashboard schema", () => {
    const dash = new Dashboard({
      title: "Vars",
      variables: [
        new QueryVariable({ name: "svc", datasource: prometheus, query: "label_values(up, job)" }),
        new CustomVariable({ name: "env", values: ["prod", "dev"] }),
        new IntervalVariable({ name: "step", values: ["1m"] }),
        new DatasourceVariable({ name: "ds", pluginType: "prometheus" }),
        new ConstantVariable({ name: "cluster", value: "x" }),
        new TextboxVariable({ name: "q", value: "y" }),
      ],
    });
    expect(validateDashboardSchema(renderDashboard(dash) as unknown as Record<string, unknown>)).toEqual([]);
  });
});

describe("extension points", () => {
  test("definePanel and defineQuery produce classes that render and lay out like built-ins", () => {
    const PieChartPanel = definePanel<{ pieType?: "pie" | "donut" }>()({ type: "piechart", className: "PieChartPanel", defaultSize: { w: 8, h: 8 } });
    const ElasticQuery = defineQuery<{ query: string; refId?: string }>()({ datasourceType: "elasticsearch", className: "ElasticQuery" });
    const es = new Datasource({ name: "Logs ES", type: "elasticsearch" });
    const json = renderDashboard(
      new Dashboard({ title: "Custom", panels: [new PieChartPanel({ options: { pieType: "donut" }, datasource: es, targets: [new ElasticQuery({ query: "*" })] })] }),
    );
    expect(json.panels![0]).toMatchObject({
      type: "piechart",
      gridPos: { w: 8, h: 8, x: 0, y: 0 },
      options: { pieType: "donut" },
      datasource: { type: "elasticsearch", uid: "logs-es" },
      targets: [{ refId: "A", query: "*" }],
    });
    expect(validateDashboardSchema(json as unknown as Record<string, unknown>)).toEqual([]);
  });

  test("redefining a built-in panel or query type throws", () => {
    expect(() => definePanel()({ type: "stat", className: "MyStat", defaultSize: { w: 1, h: 1 } })).toThrow(/built in/);
    expect(() => defineQuery()({ datasourceType: "prometheus", className: "MyProm" })).toThrow(/built in/);
    expect(() => definePanel()({ type: "row", className: "R", defaultSize: { w: 1, h: 1 } })).toThrow(/Row/);
  });

  test("dashboardJson and grafanaFiles render without a build", () => {
    const dash = new Dashboard({ title: "Plain", uid: "plain" });
    expect(JSON.parse(dashboardJson(dash)).uid).toBe("plain");
    expect(Object.keys(grafanaFiles([dash, prometheus])).sort()).toEqual([
      "dashboards/plain.json",
      "provisioning/dashboards/chant.yaml",
      "provisioning/datasources/chant.yaml",
    ]);
  });
});
