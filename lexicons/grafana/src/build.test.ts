import { describe, expect, test } from "vitest";
import { Datasource, DatasourceProvisioning, ExternalDatasource } from "./datasource";
import { Dashboard, DashboardProvider } from "./dashboard";
import { Folder } from "./folder";
import { load } from "js-yaml";
import { Row, StatPanel, TextPanel, TimeSeriesPanel, TablePanel, definePanel } from "./panels";
import { PromQuery, TempoQuery, LokiQuery, defineQuery } from "./query";
import {
  AdhocVariable,
  CustomVariable,
  ConstantVariable,
  DatasourceVariable,
  GroupByVariable,
  IntervalVariable,
  QueryVariable,
  SwitchVariable,
  TextboxVariable,
} from "./variables";
import { LibraryPanel, LibraryPanelRef } from "./library-panel";
import { planFromDashboards } from "./api/apply";
import { validateGrafanaOutput } from "./validate-output";
import { panelsJson, renderDashboard, variableModel, dashboardJson, grafanaFiles, buildGrafana, customVariableOptions, type PanelJson } from "./build";

/** The panels array, read as plain panels (the tests below build no rows unless they say so). */
function panelsOnly(items: Parameters<typeof panelsJson>[0]): PanelJson[] {
  return panelsJson(items) as PanelJson[];
}
import { validateDashboardSchema } from "./schema-validate";
import { checkGrid } from "./validate-output";

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

  test("a row with a y keeps that line, even over an empty band or on a line a panel takes (#2992)", () => {
    const panels = panelsJson([
      new StatPanel({ title: "a", gridPos: { x: 0, y: 0, w: 24, h: 4 } }),
      new Row({ title: "late", gridPos: { y: 6 }, panels: [new StatPanel({ title: "b", gridPos: { x: 0, y: 7, w: 24, h: 4 } })] }),
      new Row({ title: "auto", panels: [new StatPanel({ title: "c" })] }),
      new Row({ title: "early", gridPos: { y: 8 } }),
    ]);
    expect(panels.map((p) => [p.title, p.gridPos])).toEqual([
      ["a", { h: 4, w: 24, x: 0, y: 0 }],
      ["late", { h: 1, w: 24, x: 0, y: 6 }],
      ["b", { h: 4, w: 24, x: 0, y: 7 }],
      // An auto-placed row skips the line the "early" row reserved.
      ["auto", { h: 1, w: 24, x: 0, y: 11 }],
      ["c", { h: 4, w: 6, x: 0, y: 12 }],
      ["early", { h: 1, w: 24, x: 0, y: 8 }],
    ]);
  });

  test("an auto-placed panel flows around an explicit one declared before it (#2941)", () => {
    const panels = panelsJson([
      new TimeSeriesPanel({ title: "a", gridPos: { x: 0, y: 0, w: 12 } }),
      new TimeSeriesPanel({ title: "b", gridPos: { w: 12 } }),
    ]);
    expect(panels.map((p) => p.gridPos)).toEqual([
      { h: 8, w: 12, x: 0, y: 0 },
      { h: 8, w: 12, x: 12, y: 0 },
    ]);
  });

  test("an explicit panel reserves its cells even when declared after auto-placed ones", () => {
    const panels = panelsJson([
      new StatPanel({ title: "s1" }),
      new StatPanel({ title: "s2" }),
      new StatPanel({ title: "s3" }),
      new StatPanel({ title: "s4" }),
      new StatPanel({ title: "pinned", gridPos: { x: 6, y: 0, w: 6, h: 4 } }),
      new TextPanel({ title: "wide" }),
    ]);
    expect(panels.map((p) => [p.title, p.gridPos])).toEqual([
      ["s1", { h: 4, w: 6, x: 0, y: 0 }],
      ["s2", { h: 4, w: 6, x: 12, y: 0 }],
      ["s3", { h: 4, w: 6, x: 18, y: 0 }],
      ["s4", { h: 4, w: 6, x: 0, y: 4 }],
      ["pinned", { h: 4, w: 6, x: 6, y: 0 }],
      ["wide", { h: 3, w: 24, x: 0, y: 8 }],
    ]);
  });

  test("a line blocked by an explicit panel is skipped", () => {
    const panels = panelsJson([
      new StatPanel({ title: "band", gridPos: { x: 0, y: 0, w: 24, h: 2 } }),
      new StatPanel({ title: "hole", gridPos: { x: 0, y: 6, w: 6, h: 2 } }),
      new StatPanel({ title: "s1" }),
      new TextPanel({ title: "wide" }),
    ]);
    expect(panels.map((p) => [p.title, p.gridPos])).toEqual([
      ["band", { h: 2, w: 24, x: 0, y: 0 }],
      ["hole", { h: 2, w: 6, x: 0, y: 6 }],
      ["s1", { h: 4, w: 6, x: 0, y: 2 }],
      ["wide", { h: 3, w: 24, x: 0, y: 8 }],
    ]);
  });

  test("a partial gridPos is honoured: x only keeps its column, y only its line", () => {
    const panels = panelsJson([
      new StatPanel({ title: "right", gridPos: { x: 18 } }),
      new StatPanel({ title: "left", gridPos: { x: 0 } }),
      new StatPanel({ title: "next" }),
      new StatPanel({ title: "low", gridPos: { y: 20, w: 12 } }),
      new StatPanel({ title: "low2", gridPos: { y: 20, w: 12 } }),
      new StatPanel({ title: "low3", gridPos: { y: 20, w: 12 } }),
    ]);
    expect(panels.map((p) => [p.title, p.gridPos])).toEqual([
      ["right", { h: 4, w: 6, x: 18, y: 0 }],
      ["left", { h: 4, w: 6, x: 0, y: 4 }],
      ["next", { h: 4, w: 6, x: 6, y: 4 }],
      ["low", { h: 4, w: 12, x: 0, y: 20 }],
      ["low2", { h: 4, w: 12, x: 12, y: 20 }],
      ["low3", { h: 4, w: 12, x: 0, y: 24 }],
    ]);
  });

  test("a full-width row header skips lines taken by explicit panels", () => {
    const panels = panelsJson([
      new TimeSeriesPanel({ title: "top" }),
      new Row({
        title: "open",
        panels: [new StatPanel({ title: "pinned", gridPos: { x: 0, y: 8, w: 24, h: 2 } }), new StatPanel({ title: "a" })],
      }),
      new Row({ title: "next" }),
    ]);
    expect(panels.map((p) => [p.type, p.title, p.gridPos])).toEqual([
      ["timeseries", "top", { h: 8, w: 12, x: 0, y: 0 }],
      ["row", "open", { h: 1, w: 24, x: 0, y: 10 }],
      ["stat", "pinned", { h: 2, w: 24, x: 0, y: 8 }],
      ["stat", "a", { h: 4, w: 6, x: 0, y: 11 }],
      ["row", "next", { h: 1, w: 24, x: 0, y: 15 }],
    ]);
  });

  test("a collapsed row's panels flow around its own explicit panels and don't block the dashboard", () => {
    const panels = panelsJson([
      new Row({
        title: "shut",
        collapsed: true,
        panels: [new StatPanel({ title: "pinned", gridPos: { x: 0, y: 1, w: 6, h: 4 } }), new StatPanel({ title: "a" })],
      }),
      new StatPanel({ title: "after" }),
    ]);
    const shut = panels[0] as unknown as { panels: PanelJson[] };
    expect(shut.panels.map((p) => [p.title, p.gridPos])).toEqual([
      ["pinned", { h: 4, w: 6, x: 0, y: 1 }],
      ["a", { h: 4, w: 6, x: 6, y: 1 }],
    ]);
    expect(panels[1].gridPos).toEqual({ h: 4, w: 6, x: 0, y: 1 });
  });

  test("a mixed layout built by the dashboard passes GRAF105", () => {
    const dash = new Dashboard({
      title: "Mixed",
      panels: [
        new TimeSeriesPanel({ title: "a", gridPos: { x: 0, y: 0, w: 12 } }),
        new TimeSeriesPanel({ title: "b", gridPos: { w: 12 } }),
        new StatPanel({ title: "c", gridPos: { x: 6 } }),
        new StatPanel({ title: "d", gridPos: { x: 12, y: 8, w: 12, h: 4 } }),
        new StatPanel({ title: "e" }),
        new Row({ title: "r", panels: [new StatPanel({ title: "f", gridPos: { x: 18, y: 12 } }), new StatPanel({ title: "g" })] }),
      ],
    });
    expect(checkGrid({ dashboards: [{ json: JSON.parse(dashboardJson(dash)) }], datasources: [] })).toEqual([]);
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

  test("a panel declared Mixed stays Mixed, and a query naming no datasource is not sent to Mixed (#2992)", () => {
    const mixed = { type: "datasource", uid: "-- Mixed --" };
    const [bare, panel] = panelsOnly([
      new TextPanel({ datasource: mixed }),
      new StatPanel({ datasource: mixed, targets: [new PromQuery({ expr: "up", datasource: prometheus }), new PromQuery({ expr: "down" })] }),
    ]);
    expect(bare.datasource).toEqual(mixed);
    expect(panel.datasource).toEqual(mixed);
    expect(panel.targets!.map((t) => (t as { datasource?: unknown }).datasource)).toEqual([{ type: "prometheus", uid: "prometheus" }, undefined]);
  });

  test("a panel takes its queries' shared datasource, and a row's datasource stays on the row (#2983)", () => {
    const [shared] = panelsOnly([new StatPanel({ targets: [new PromQuery({ expr: "up", datasource: prometheus })] })]);
    expect(shared.datasource).toEqual({ type: "prometheus", uid: "prometheus" });
    const [rowJson, child] = panelsOnly([new Row({ title: "r", datasource: prometheus, panels: [new StatPanel({ targets: [new PromQuery({ expr: "up" })] })] })]);
    expect(rowJson.datasource).toEqual({ type: "prometheus", uid: "prometheus" });
    expect(child.datasource).toBeUndefined();
    expect((child.targets![0] as { datasource?: unknown }).datasource).toBeUndefined();
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
    expect(variableModel(new CustomVariable({ name: "env", values: ["a"], hide: "controlsMenu", allowCustomValue: false }))).toMatchObject({ hide: 3, allowCustomValue: false });
    expect(variableModel(new ConstantVariable({ name: "cluster", value: "prod-1" }))).toMatchObject({ type: "constant", query: "prod-1", hide: 2 });
    expect(variableModel(new TextboxVariable({ name: "q" }))).toMatchObject({ type: "textbox", query: "" });
  });

  test("an object query is written as it is, its text as the definition", () => {
    const query = { qryType: 1 as const, query: "label_values(up, job)", refId: "PrometheusVariableQueryEditor-VariableQuery" };
    expect(variableModel(new QueryVariable({ name: "job", datasource: prometheus, query }))).toMatchObject({ query, definition: "label_values(up, job)" });
    expect(variableModel(new QueryVariable({ name: "ns", datasource: prometheus, query: { namespace: "AWS/EC2" }, definition: "Namespaces" }))).toMatchObject({
      query: { namespace: "AWS/EC2" },
      definition: "Namespaces",
    });
  });

  test("ad hoc, group by and switch variables as Grafana writes them", () => {
    const ds = new DatasourceVariable({ name: "ds", pluginType: "prometheus" });
    expect(variableModel(new AdhocVariable({ name: "f", datasource: ds, filters: [{ key: "ns", operator: "=", value: "shop" }] }))).toEqual({
      type: "adhoc",
      name: "f",
      datasource: { type: "prometheus", uid: "${ds}" },
      filters: [{ key: "ns", operator: "=", value: "shop" }],
      baseFilters: [],
    });
    expect(variableModel(new GroupByVariable({ name: "by", datasource: prometheus, options: ["pod", { text: "Node", value: "node" }], defaultValue: ["pod"] }))).toEqual({
      type: "groupby",
      name: "by",
      datasource: { type: "prometheus", uid: prometheus.uid },
      options: [
        { text: "pod", value: "pod" },
        { text: "Node", value: "node" },
      ],
      current: { text: ["pod"], value: ["pod"] },
      defaultValue: { text: ["pod"], value: ["pod"] },
    });
    expect(variableModel(new SwitchVariable({ name: "on" }))).toEqual({
      type: "switch",
      name: "on",
      current: { text: "false", value: "false" },
      options: [
        { text: "true", value: "true" },
        { text: "false", value: "false" },
      ],
    });
    expect(variableModel(new SwitchVariable({ name: "q", enabled: true, enabledValue: "0.99", disabledValue: "0.5" }))).toMatchObject({
      current: { text: "0.99", value: "0.99" },
      options: [
        { text: "0.99", value: "0.99" },
        { text: "0.5", value: "0.5" },
      ],
    });
  });

  test("a custom value in Grafana's `text : value` syntax shows the text and sets the value (#2944)", () => {
    const v = variableModel(new CustomVariable({ name: "env", values: ["Production : prod", "Staging : stg", "dev"] }));
    expect(v).toMatchObject({
      query: "Production : prod,Staging : stg,dev",
      current: { text: "Production", value: "prod" },
      options: [
        { selected: true, text: "Production", value: "prod" },
        { selected: false, text: "Staging", value: "stg" },
        { selected: false, text: "dev", value: "dev" },
      ],
    });
  });

  test("a custom value's selected option follows current by value, and multi-value current selects several", () => {
    const v = variableModel(
      new CustomVariable({ name: "env", multi: true, values: ["Production : prod", "Staging : stg"], current: { text: ["Staging"], value: ["stg"] } }),
    );
    expect((v as { options: Array<{ selected: boolean }> }).options.map((o) => o.selected)).toEqual([false, true]);
  });

  test("a comma already escaped as \\, is not escaped again (#2944)", () => {
    const v = variableModel(new CustomVariable({ name: "pair", values: ["a\\,b", "c,d", "Label, with comma : x\\,y"] }));
    expect(v).toMatchObject({
      query: "a\\,b,c\\,d,Label\\, with comma : x\\,y",
      options: [
        { text: "a,b", value: "a,b" },
        { text: "c,d", value: "c,d" },
        { text: "Label, with comma", value: "x,y" },
      ],
    });
  });

  test("customVariableOptions parses a query the way Grafana does", () => {
    expect(customVariableOptions("a : 1, b,c\\,d , ,x:y, k : v : w")).toEqual([
      { text: "a", value: "1" },
      { text: "b", value: "b" },
      { text: "c,d", value: "c,d" },
      { text: "", value: "" },
      // No spaces around the colon: one plain value.
      { text: "x:y", value: "x:y" },
      // Grafana's first group is greedy: the last ` : ` splits.
      { text: "k : v", value: "w" },
    ]);
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
        new QueryVariable({ name: "pods", datasource: prometheus, query: { qryType: 1, query: "label_values(kube_pod_info, pod)" } }),
        new AdhocVariable({ name: "f", datasource: prometheus, baseFilters: [{ key: "cluster", operator: "=", value: "prod" }], defaultKeys: [{ text: "pod" }] }),
        new GroupByVariable({ name: "by", datasource: prometheus, options: ["pod"] }),
        new SwitchVariable({ name: "on", enabled: true }),
      ],
    });
    expect(validateDashboardSchema(renderDashboard(dash) as unknown as Record<string, unknown>)).toEqual([]);
  });
});

describe("extension points", () => {
  test("definePanel and defineQuery produce classes that render and lay out like built-ins", () => {
    const ClockPanel = definePanel<{ mode?: "time" | "countdown" }>()({ type: "grafana-clock-panel", className: "ClockPanel", defaultSize: { w: 8, h: 8 } });
    const SplunkQuery = defineQuery<{ query: string; refId?: string }>()({ datasourceType: "grafana-splunk-datasource", className: "SplunkQuery" });
    const os = new Datasource({ name: "Logs Splunk", type: "grafana-splunk-datasource" });
    const json = renderDashboard(
      new Dashboard({ title: "Custom", panels: [new ClockPanel({ options: { mode: "countdown" }, datasource: os, targets: [new SplunkQuery({ query: "*" })] })] }),
    );
    expect(json.panels![0]).toMatchObject({
      type: "grafana-clock-panel",
      gridPos: { w: 8, h: 8, x: 0, y: 0 },
      options: { mode: "countdown" },
      datasource: { type: "grafana-splunk-datasource", uid: "logs-splunk" },
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

describe("folders (#2944)", () => {
  test("a nested folder is written as nested directories under dashboards/", () => {
    const built = buildGrafana([new Dashboard({ title: "Pods", uid: "pods", folder: "Platform/Kubernetes" })]);
    expect(built.dashboards[0].file).toBe("dashboards/Platform/Kubernetes/pods.json");
    expect(built.index.dashboards[0].folder).toBe("Platform/Kubernetes");
  });

  test("blank levels, dot-led levels and backslashes can't leave dashboards/", () => {
    const file = (folder: string) => buildGrafana([new Dashboard({ title: "D", uid: "d", folder })]).dashboards[0].file;
    expect(file("/Platform//Kubernetes/")).toBe("dashboards/Platform/Kubernetes/d.json");
    expect(file("../../etc")).toBe("dashboards/etc/d.json");
    expect(file("a\\b")).toBe("dashboards/a-b/d.json");
    expect(file(" / ")).toBe("dashboards/d.json");
  });
});

describe("folder uids and nesting (#2953)", () => {
  const platform = new Folder({ title: "Platform", uid: "plat" });
  const k8s = new Folder({ title: "Kubernetes", parent: platform });

  test("a Folder is written where its path is, and the index lists every level with its uid and parent", () => {
    const built = buildGrafana(
      new Map<string, never>([
        ["pods", new Dashboard({ title: "Pods", uid: "pods", folder: k8s }) as never],
        ["nodes", new Dashboard({ title: "Nodes", uid: "nodes", folder: "Platform/Kubernetes/Nodes" }) as never],
        ["spare", new Folder({ title: "Spare" }) as never],
      ]),
    );
    expect(built.dashboards.map((d) => [d.file, d.folder, d.folderUid])).toEqual([
      ["dashboards/Platform/Kubernetes/pods.json", "Platform/Kubernetes", "platform-kubernetes"],
      ["dashboards/Platform/Kubernetes/Nodes/nodes.json", "Platform/Kubernetes/Nodes", "platform-kubernetes-nodes"],
    ]);
    expect(built.index.folders).toEqual([
      { uid: "plat", title: "Platform", path: "Platform" },
      { uid: "platform-kubernetes", title: "Kubernetes", parentUid: "plat", path: "Platform/Kubernetes" },
      { uid: "platform-kubernetes-nodes", title: "Nodes", parentUid: "platform-kubernetes", path: "Platform/Kubernetes/Nodes" },
      { uid: "spare", title: "Spare", path: "Spare" },
    ]);
  });

  test("a path and a Folder at the same path are one folder; the Folder's uid wins", () => {
    const built = buildGrafana([new Dashboard({ title: "A", uid: "a", folder: "Platform" }), new Dashboard({ title: "B", uid: "b", folder: platform })]);
    expect(built.dashboards.map((d) => d.folderUid)).toEqual(["plat", "plat"]);
    expect(built.folders).toEqual([{ uid: "plat", title: "Platform", path: "Platform" }]);
  });

  test("a Folder title is one level, and two uids at one path are refused", () => {
    expect(() => new Folder({ title: "Platform/Kubernetes" })).toThrow(/not one folder level/);
    expect(() => buildGrafana([new Folder({ title: "X", uid: "one" }), new Folder({ title: "X", uid: "two" })])).toThrow(/declared with the uids "one" and "two"/);
  });

  test("a root-level Folder on a DashboardProvider is written as folder and folderUid; a nested one is refused", () => {
    const built = buildGrafana([new DashboardProvider({ name: "ops", folder: platform, path: "/d" })]);
    expect(built.providers[0]).toMatchObject({ folder: "Platform", folderUid: "plat", options: { foldersFromFilesStructure: false } });
    expect(() => new DashboardProvider({ name: "ops", folder: k8s })).toThrow(/nested; Grafana creates a provider's folder at the root/);
  });
});

describe("annotations (#2953)", () => {
  test("an annotation is written with its datasource resolved and Grafana's defaults filled in", () => {
    const json = renderDashboard(
      new Dashboard({
        title: "D",
        annotations: [
          { name: "Deploys", datasource: prometheus, target: new PromQuery({ expr: "changes(up[5m]) > 0" }), titleFormat: "deploy" },
          { name: "Incidents", datasource: { type: "grafana", uid: "-- Grafana --" }, enable: false, iconColor: "blue", target: { type: "tags", tags: ["incident"], limit: 100, matchAny: false } },
        ],
      }),
    );
    expect(json.annotations).toEqual({
      list: [
        { datasource: { type: "prometheus", uid: "prometheus" }, enable: true, iconColor: "red", name: "Deploys", titleFormat: "deploy", target: expect.objectContaining({ refId: "Anno", expr: "changes(up[5m]) > 0" }) },
        { datasource: { type: "grafana", uid: "-- Grafana --" }, enable: false, iconColor: "blue", name: "Incidents", target: { type: "tags", tags: ["incident"], limit: 100, matchAny: false } },
      ],
    });
    expect(validateDashboardSchema(json as never).filter((p) => p.severity === "error")).toEqual([]);
    expect(renderDashboard(new Dashboard({ title: "E" })).annotations).toEqual({ list: [] });
  });
});

describe("datasource prune (#2953)", () => {
  const files = (entities: unknown[]) => load(buildGrafana(entities as never).files["provisioning/datasources/chant.yaml"] ?? "null") as Record<string, unknown> | null;

  test("the datasource file prunes by default, so a removed Datasource leaves Grafana", () => {
    expect(files([prometheus])).toMatchObject({ apiVersion: 1, prune: true });
  });

  test("DatasourceProvisioning turns pruning off and lists datasources to delete", () => {
    const out = files([prometheus, new DatasourceProvisioning({ prune: false, deleteDatasources: [{ name: "Old" }, { name: "Other", orgId: 2 }] })]);
    expect(out).toEqual({ apiVersion: 1, deleteDatasources: [{ name: "Old" }, { name: "Other", orgId: 2 }], datasources: [expect.objectContaining({ name: "Prometheus" })] });
    expect(files([new DatasourceProvisioning({ deleteDatasources: [{ name: "Old" }] })])).toEqual({ apiVersion: 1, prune: true, deleteDatasources: [{ name: "Old" }], datasources: [] });
    expect(files([new ExternalDatasource({ type: "prometheus", uid: "p" })])).toBeNull();
    expect(() => buildGrafana([new DatasourceProvisioning({}), new DatasourceProvisioning({})])).toThrow(/at most one DatasourceProvisioning/);
  });
});

describe("library panels (#3010)", () => {
  const burn = new LibraryPanel({
    name: "Burn rate",
    folder: "SLOs",
    panel: new TimeSeriesPanel({ title: "Burn rate", gridPos: { w: 24, h: 6 }, targets: [new PromQuery({ expr: "up", datasource: prometheus })] }),
  });

  test("a LibraryPanel in panels is a reference, laid out at its panel's size, and its model goes in __elements", () => {
    const json = renderDashboard(new Dashboard({ title: "SLO", panels: [new StatPanel({ title: "s" }), burn] })) as unknown as Record<string, unknown>;
    expect(json.panels).toEqual([
      expect.objectContaining({ type: "stat", id: 1 }),
      { id: 2, gridPos: { h: 8, w: 12, x: 6, y: 0 }, libraryPanel: { uid: "burn-rate", name: "Burn rate" } },
    ]);
    expect(json.__elements).toEqual({
      "burn-rate": {
        name: "Burn rate",
        uid: "burn-rate",
        kind: 1,
        model: {
          type: "timeseries",
          title: "Burn rate",
          datasource: { type: "prometheus", uid: "prometheus" },
          targets: [{ datasource: { type: "prometheus", uid: "prometheus" }, refId: "A", expr: "up" }],
          options: {},
          fieldConfig: { defaults: {}, overrides: [] },
        },
        folderUid: "slos",
      },
    });
    expect(validateDashboardSchema(json as never).filter((p) => p.severity === "error")).toEqual([]);
  });

  test("a LibraryPanelRef places it, in a row too; one in Grafana is referenced by { uid, name } and not written", () => {
    const json = renderDashboard(
      new Dashboard({
        title: "SLO",
        panels: [
          new LibraryPanelRef({ libraryPanel: burn, id: 7, gridPos: { x: 0, y: 0, w: 24, h: 6 }, title: "Burn rate" }),
          new Row({ title: "More", panels: [new LibraryPanelRef({ libraryPanel: { uid: "shared-owners", name: "Owners" } }), burn] }),
        ],
      }),
    ) as unknown as Record<string, unknown>;
    expect(json.panels).toEqual([
      { id: 7, gridPos: { h: 6, w: 24, x: 0, y: 0 }, libraryPanel: { uid: "burn-rate", name: "Burn rate" }, title: "Burn rate" },
      expect.objectContaining({ type: "row", title: "More" }),
      { id: 2, gridPos: { h: 8, w: 12, x: 0, y: 7 }, libraryPanel: { uid: "shared-owners", name: "Owners" } },
      { id: 3, gridPos: { h: 8, w: 12, x: 12, y: 7 }, libraryPanel: { uid: "burn-rate", name: "Burn rate" } },
    ]);
    expect(Object.keys(json.__elements as object)).toEqual(["burn-rate"]);
    expect(() => new LibraryPanelRef({ libraryPanel: "burn-rate" as never })).toThrow(/must be a LibraryPanel or a \{ uid, name \}/);
    expect(() => renderDashboard(new Dashboard({ title: "X", panels: [burn, new LibraryPanel({ name: "Other", uid: "burn-rate", panel: new StatPanel({}) })] }))).toThrow(
      /two different LibraryPanels with the uid "burn-rate"/,
    );
  });

  test("the build makes the library panel's folder, the checks pass, and the applier writes it there, before the dashboards", () => {
    const slos = new Folder({ title: "SLOs", uid: "slo-folder" });
    const pinned = new LibraryPanel({ name: "Pinned", folder: slos, panel: new StatPanel({ title: "Pinned" }) });
    const built = buildGrafana(
      new Map<string, never>([
        ["prometheus", prometheus as never],
        ["burn", burn as never],
        ["slo", new Dashboard({ title: "SLO", folder: "Team A", panels: [burn, pinned] }) as never],
        ["other", new Dashboard({ title: "Other", panels: [burn] }) as never],
      ]),
    );
    expect(built.folders.map((f) => [f.path, f.uid])).toEqual([
      ["SLOs", "slo-folder"],
      ["Team A", "team-a"],
    ]);
    const issues = validateGrafanaOutput({ dashboards: built.dashboards.map((d) => ({ source: d.file, json: d.json as never })), datasources: built.datasources });
    expect(issues.filter((i) => i.severity === "error")).toEqual([]);
    const plan = planFromDashboards(built.dashboards.map((d) => ({ json: d.json as never, folder: d.folder, folderUid: d.folderUid })), built.folders);
    // "SLOs" is a path on burn, and the Folder of that path pins its uid.
    expect(plan.libraryPanels.map((p) => [p.uid, p.folderUid])).toEqual([
      ["burn-rate", "slo-folder"],
      ["pinned", "slo-folder"],
    ]);
    expect(plan.dashboards.every((d) => !("__elements" in d.json))).toBe(true);
  });
});
