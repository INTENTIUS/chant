import { describe, expect, test } from "vitest";
import { detectTemplate } from "../detect";
import { DASHBOARD_SCHEMA_VERSION } from "../schema/dashboard.gen";
import { GrafanaParser, planDashboard, type DashboardResourceMetadata, type PlanResourceProperties } from "./parser";
import { applyEdits } from "./edits";
import type { Declaration } from "./model";
import { read, V2_EXPORTS } from "./testdata/fixtures";

type Json = Record<string, unknown>;

const parse = (doc: unknown) => new GrafanaParser().parse(typeof doc === "string" ? doc : JSON.stringify(doc));

/** A minimal classic dashboard with the given parts. */
function dashboard(parts: Json = {}): Json {
  return { title: "T", uid: "t", schemaVersion: DASHBOARD_SCHEMA_VERSION, panels: [], templating: { list: [] }, ...parts };
}

function decl(declarations: readonly Declaration[], id: string): Declaration {
  const d = declarations.find((x) => x.id === id);
  if (!d) throw new Error(`no declaration ${id} in ${declarations.map((x) => x.id).join(", ")}`);
  return d;
}

const prom = { type: "prometheus", uid: "prom" };

describe("what the parser accepts", () => {
  // v2 dashboards (#2947) are read into classic JSON; v2.test.ts covers them.
  test("a v2 resource is read into a classic dashboard", () => {
    const ir = parse(read(V2_EXPORTS[0]));
    expect(ir.resources.map((r) => r.logicalId)).toEqual(["checkoutService"]);
    expect(ir.warnings?.[0]).toMatch(/^This is a v2 dashboard \(dashboard\.grafana\.app\/v2\)\./);
  });

  test("a bare v2 spec is read too", () => {
    const ir = parse({ title: "x", elements: {}, layout: { kind: "GridLayout", spec: { items: [] } } });
    expect(ir.resources).toHaveLength(1);
    expect(ir.warnings?.[0]).toMatch(/^This is a v2 dashboard\. /);
  });

  test("a dashboard from before Grafana 5.0 is reported, not imported", () => {
    const ir = parse({ title: "old", schemaVersion: 12, rows: [{ panels: [] }] });
    expect(ir.resources).toEqual([]);
    expect(ir.warnings?.[0]).toMatch(/^This dashboard was saved before Grafana 5\.0 \(schemaVersion 12\)/);
  });

  test("a dashboard.grafana.app v1 resource is unwrapped, its uid taken from metadata.name", () => {
    const ir = parse({ apiVersion: "dashboard.grafana.app/v1beta1", kind: "Dashboard", metadata: { name: "abc" }, spec: { title: "T", schemaVersion: 42, panels: [] } });
    const meta = ir.resources[0].metadata as unknown as DashboardResourceMetadata;
    expect(meta.source.uid).toBe("abc");
    expect(ir.warnings).toEqual([]);
  });

  test("an /api/dashboards/uid response is unwrapped", () => {
    const ir = parse({ dashboard: dashboard({ id: 7, version: 3 }), meta: { slug: "t" } });
    expect(ir.resources[0].logicalId).toBe("t");
    // The stored copy's id and version are Grafana's bookkeeping: dropped without a word.
    expect(ir.warnings).toEqual([]);
  });

  test("anything else is an error", () => {
    expect(() => parse({ hello: "world" })).toThrow(/not Grafana dashboard JSON/);
    expect(() => parse("[1, 2]")).toThrow(/expected Grafana dashboard JSON/);
  });

  test("detectTemplate claims every shape the parser reads", () => {
    expect(detectTemplate(JSON.parse(read(V2_EXPORTS[0])))).toBe(true);
    expect(detectTemplate({ title: "old", schemaVersion: 12, rows: [] })).toBe(true);
    expect(detectTemplate({ dashboard: dashboard(), meta: {} })).toBe(true);
    expect(detectTemplate({ apiVersion: "dashboard.grafana.app/v1beta1", kind: "Dashboard", spec: dashboard() })).toBe(true);
    expect(detectTemplate({ apiVersion: "v1", kind: "ConfigMap", spec: {} })).toBe(false);
  });
});

describe("__inputs", () => {
  const exported = dashboard({
    __inputs: [
      { name: "DS_PROM", label: "Prometheus", type: "datasource", pluginId: "prometheus", pluginName: "Prometheus" },
      { name: "VAR_ENV", type: "constant", label: "env", value: "prod" },
    ],
    __requires: [{ type: "grafana", id: "grafana", version: "12.4.11" }],
    panels: [{ type: "stat", id: 1, title: "Up in ${VAR_ENV}", datasource: { type: "prometheus", uid: "${DS_PROM}" }, targets: [{ refId: "A", expr: "up" }] }],
  });

  test("a datasource input becomes a DatasourceVariable of the same name, first in the list", () => {
    const { plan, edits, warnings } = planDashboard(exported);
    expect(decl(plan.declarations, "variable:DS_PROM")).toMatchObject({
      className: "DatasourceVariable",
      props: { name: "DS_PROM", label: "Prometheus", pluginType: "prometheus" },
    });
    expect(decl(plan.declarations, "panel:0").props!.datasource).toEqual({ $decl: "variable:DS_PROM" });
    expect(decl(plan.declarations, "dashboard").props!.variables).toEqual([{ $decl: "variable:DS_PROM" }]);
    expect(edits).toContainEqual({
      op: "prependVariable",
      value: { type: "datasource", name: "DS_PROM", label: "Prometheus", query: "prometheus", regex: "", refresh: 1, options: [] },
    });
    expect(warnings).toContainEqual(expect.stringMatching(/^__inputs: DS_PROM \(prometheus\) becomes a datasource variable/));
  });

  test("a constant input is filled in with its value", () => {
    const { plan, edits, warnings } = planDashboard(exported);
    expect(decl(plan.declarations, "panel:0").props!.title).toBe("Up in prod");
    expect(edits).toContainEqual({ op: "substitute", from: "${VAR_ENV}", to: "prod" });
    expect(warnings).toContain('__inputs: the constant VAR_ENV is written as its value "prod", the value Grafana\'s import dialog fills in');
    expect(applyEdits(exported, edits).panels).toEqual([expect.objectContaining({ title: "Up in prod" })]);
  });

  test("an input the dashboard also declares as a variable is that variable", () => {
    const d = dashboard({
      __inputs: [{ name: "ds", type: "datasource", pluginId: "prometheus" }],
      templating: { list: [{ type: "datasource", name: "ds", query: "prometheus" }] },
    });
    const { plan } = planDashboard(d);
    expect(plan.declarations.filter((x) => x.className === "DatasourceVariable").map((x) => x.id)).toEqual(["variable:ds"]);
  });
});

describe("datasource references", () => {
  function panelWith(datasource: unknown, targets: Json[] = [{ refId: "A", expr: "up" }]) {
    return dashboard({
      templating: { list: [{ type: "datasource", name: "ds", query: "prometheus" }] },
      panels: [{ type: "timeseries", id: 1, title: "p", gridPos: { h: 4, w: 6, x: 0, y: 0 }, datasource, targets }],
    });
  }

  test("a concrete uid becomes one ExternalDatasource, shared by everything that names it and exported", () => {
    const { plan } = planDashboard(panelWith(prom, [{ refId: "A", expr: "up", datasource: prom }]));
    expect(decl(plan.declarations, "datasource:prometheus:prom")).toMatchObject({ kind: "new", className: "ExternalDatasource", props: prom });
    expect(plan.exports).toEqual(["datasource:prometheus:prom", "dashboard"]);
    // The query's datasource is the panel's, so the build writes it from the panel.
    expect(decl(plan.declarations, "query:0:0").props).toEqual({ refId: "A", expr: "up" });
    expect(decl(plan.declarations, "query:0:0").className).toBe("PromQuery");
  });

  test("panels, rows, queries and variables are property-kind; datasources, the dashboard and a plugin's panel are not (#2988)", () => {
    const { plan } = planDashboard(
      dashboard({
        templating: { list: [{ type: "textbox", name: "q", query: "" }] },
        panels: [
          { type: "row", id: 1, title: "R", collapsed: false, gridPos: { h: 1, w: 24, x: 0, y: 0 } },
          { type: "timeseries", id: 2, title: "p", gridPos: { h: 4, w: 6, x: 0, y: 1 }, datasource: prom, targets: [{ refId: "A", expr: "up" }] },
          { type: "grafana-clock-panel", id: 3, title: "c", gridPos: { h: 4, w: 6, x: 6, y: 1 } },
        ],
      }),
    );
    const property = Object.fromEntries(plan.declarations.map((d) => [d.id, d.property === true]));
    expect(property).toEqual({
      "variable:q": true,
      "datasource:prometheus:prom": false,
      "query:0:0": true,
      "panel:0": true,
      "panel:1": false,
      "row:0": true,
      dashboard: false,
    });
    expect(plan.main).toBe("dashboard");
    expect(plan.modules.filter((m) => m.separable).map((m) => m.file)).toEqual(["row-r"]);
  });

  test("an OpenSearch query is declared with OpenSearchQuery, not a defineQuery", () => {
    const os = { type: "grafana-opensearch-datasource", uid: "os" };
    const { plan } = planDashboard(panelWith(os, [{ refId: "A", query: "source = logs | head 5", queryType: "PPL", format: "table", datasource: os }]));
    expect(decl(plan.declarations, "query:0:0")).toMatchObject({ className: "OpenSearchQuery", props: { refId: "A", query: "source = logs | head 5", queryType: "PPL", format: "table" } });
    expect(plan.customClasses).toEqual([]);
  });

  test("$ds, ${ds} and [[ds]] are the datasource variable", () => {
    for (const uid of ["$ds", "${ds}", "[[ds]]"]) {
      const { plan, warnings } = planDashboard(panelWith({ type: "prometheus", uid }));
      expect(decl(plan.declarations, "panel:0").props!.datasource).toEqual({ $decl: "variable:ds" });
      expect(warnings).toEqual([]);
    }
  });

  test("a name from before Grafana 8.3 that is a variable is the variable; any other name is reported", () => {
    const byVariable = planDashboard(panelWith("$ds"));
    expect(decl(byVariable.plan.declarations, "panel:0").props!.datasource).toEqual({ $decl: "variable:ds" });
    expect(byVariable.edits).toContainEqual({ op: "replace", path: "/panels/0/datasource", value: { type: "prometheus", uid: "${ds}" } });
    const byName = planDashboard(panelWith("Prometheus"));
    expect(decl(byName.plan.declarations, "panel:0").props!.datasource).toBeUndefined();
    expect(byName.warnings).toContain('panel "p" (id 1): datasource is not carried (it names the datasource "Prometheus" rather than its uid, from before Grafana 8.3)');
  });

  test("a panel's Mixed datasource is carried, and its queries keep their own", () => {
    const { plan, warnings, edits } = planDashboard(
      panelWith({ type: "datasource", uid: "-- Mixed --" }, [
        { refId: "A", expr: "up", datasource: prom },
        { refId: "B", query: "{}", datasource: { type: "tempo", uid: "tempo" } },
      ]),
    );
    expect(decl(plan.declarations, "panel:0").props!.datasource).toEqual({ $decl: "datasource:datasource:-- Mixed --" });
    expect(decl(plan.declarations, "datasource:datasource:-- Mixed --")).toMatchObject({ kind: "value", value: { type: "datasource", uid: "-- Mixed --" } });
    expect(decl(plan.declarations, "query:0:0").props!.datasource).toEqual({ $decl: "datasource:prometheus:prom" });
    expect(decl(plan.declarations, "query:0:1").className).toBe("TempoQuery");
    expect(warnings).toEqual([]);
    expect(edits.filter((e) => "path" in e && e.path.endsWith("/datasource"))).toEqual([]);
  });

  test("a panel with no queries keeps its Mixed datasource (kube-prometheus apiserver)", () => {
    const { plan, warnings } = planDashboard(dashboard({ panels: [{ type: "text", id: 1, gridPos: { h: 4, w: 6, x: 0, y: 0 }, datasource: { type: "datasource", uid: "-- Mixed --" }, targets: [] }] }));
    expect(decl(plan.declarations, "panel:0").props!.datasource).toEqual({ $decl: "datasource:datasource:-- Mixed --" });
    expect(warnings).toEqual([]);
  });

  test("Mixed on a query or a row is not carried, and is reported", () => {
    const mixed = { type: "datasource", uid: "-- Mixed --" };
    const { edits, warnings } = planDashboard(
      dashboard({
        panels: [
          { type: "row", id: 1, title: "R", collapsed: true, datasource: mixed, panels: [{ type: "stat", id: 2, title: "s", datasource: prom, targets: [{ refId: "A", expr: "up", datasource: mixed }] }] },
        ],
      }),
    );
    expect(edits).toContainEqual({ op: "remove", path: "/panels/0/datasource" });
    expect(edits).toContainEqual({ op: "remove", path: "/panels/0/panels/0/targets/0/datasource" });
    expect(warnings).toContainEqual(expect.stringMatching(/^row "R": datasource is not carried \(it is "-- Mixed --", which only a panel can have/));
    expect(warnings).toContainEqual(expect.stringMatching(/^panel "s" \(id 2\) query A: datasource is not carried \(it is "-- Mixed --"/));
  });

  test("a query with no datasource anywhere gets a class of its own", () => {
    const { plan } = planDashboard(dashboard({ panels: [{ type: "stat", id: 1, targets: [{ refId: "A", expr: "up" }] }] }));
    expect(decl(plan.declarations, "query:0:0")).toMatchObject({ className: "DefaultDatasourceQuery", customClass: "query-class:default" });
    expect(plan.customClasses.map((c) => c.definition)).toEqual([{ datasourceType: "default", className: "DefaultDatasourceQuery" }]);
  });

  test("Grafana's own pseudo-datasources stay DatasourceRef consts", () => {
    const { plan } = planDashboard(panelWith({ type: "datasource", uid: "-- Dashboard --" }));
    expect(decl(plan.declarations, "datasource:datasource:-- Dashboard --")).toMatchObject({
      kind: "value",
      value: { type: "datasource", uid: "-- Dashboard --" },
      type: { text: 'DatasourceRef<"datasource">', imports: ["DatasourceRef"] },
    });
    expect(plan.exports).toEqual(["dashboard"]);
  });

  test("a ref with no uid, or a concrete uid with no type, is reported", () => {
    expect(planDashboard(panelWith({ type: "prometheus" })).warnings).toContain('panel "p" (id 1): datasource is not carried (it names no uid, only the type prometheus)');
    expect(planDashboard(panelWith({ uid: "abc" })).warnings).toContain(`panel "p" (id 1): datasource is not carried (it names the uid "abc" but not the datasource's type)`);
  });
});

describe("variables", () => {
  const plan = (list: Json[]) => planDashboard(dashboard({ templating: { list } }));

  test("each type the lexicon has a class for", () => {
    const { plan: p, warnings } = plan([
      { type: "datasource", name: "ds", query: "prometheus", regex: "/prod/", current: { text: "P", value: "p" }, refresh: 1, options: [] },
      { type: "query", name: "job", datasource: { type: "prometheus", uid: "${ds}" }, query: "label_values(up, job)", definition: "label_values(up, job)", refresh: 2, sort: 1, multi: true, includeAll: true, options: [{ text: "a", value: "a" }] },
      { type: "custom", name: "env", query: "prod, staging,dev", current: { text: "prod", value: "prod" }, options: [] },
      { type: "interval", name: "w", query: "1m,5m", auto: true, auto_count: 10, auto_min: "10s", refresh: 2 },
      { type: "constant", name: "c", query: "v", hide: 2 },
      { type: "textbox", name: "t", query: "x", current: { text: "x", value: "x" } },
    ]);
    expect(warnings).toEqual([]);
    const props = (id: string) => [decl(p.declarations, id).className, decl(p.declarations, id).props];
    expect(props("variable:ds")).toEqual(["DatasourceVariable", { name: "ds", pluginType: "prometheus", regex: "/prod/", current: { text: "P", value: "p" } }]);
    expect(props("variable:job")).toEqual([
      "QueryVariable",
      { name: "job", datasource: { $decl: "variable:ds" }, query: "label_values(up, job)", refresh: "onTimeRangeChange", sort: 1, multi: true, includeAll: true },
    ]);
    expect(props("variable:env")).toEqual(["CustomVariable", { name: "env", values: ["prod", "staging", "dev"], current: { text: "prod", value: "prod" } }]);
    expect(props("variable:w")).toEqual(["IntervalVariable", { name: "w", values: ["1m", "5m"], auto: true, autoCount: 10 }]);
    expect(props("variable:c")).toEqual(["ConstantVariable", { name: "c", value: "v" }]);
    expect(props("variable:t")).toEqual(["TextboxVariable", { name: "t", value: "x" }]);
    // Datasource variables are declared first, so what refers to them comes after; the dashboard keeps the order.
    expect(p.declarations.filter((d) => d.module === "variables").map((d) => d.id)[0]).toBe("variable:ds");
  });

  test("a type the lexicon has no class for is reported and left out", () => {
    const { plan: p, warnings, edits } = plan([{ type: "system", name: "__org", query: "" }]);
    expect(p.declarations.filter((d) => d.module === "variables")).toEqual([]);
    expect(warnings).toEqual(['variable "__org" (system) is not carried: chant has no system variable, so it is left out']);
    expect(edits).toContainEqual({ op: "remove", path: "/templating/list/0" });
  });

  test("ad hoc, group by and switch variables", () => {
    const { plan: p, warnings, edits } = plan([
      {
        type: "adhoc",
        name: "Filters",
        datasource: prom,
        filters: [{ key: "namespace", operator: "=", value: "shop" }],
        baseFilters: [],
        defaultKeys: [{ text: "pod", value: "pod" }],
        allowCustomValue: false,
        enableGroupBy: false,
      },
      {
        type: "groupby",
        name: "by",
        datasource: prom,
        options: [{ text: "pod", value: "pod" }, { text: "Node", value: "node" }],
        current: { text: ["node"], value: ["node"] },
        defaultValue: { text: ["pod"], value: ["pod"] },
      },
      { type: "switch", name: "on", current: { text: "true", value: "true" }, options: [{ text: "true", value: "true" }, { text: "false", value: "false" }] },
      { type: "switch", name: "q", current: { text: "0.5", value: "0.5" }, options: [{ text: "0.99", value: "0.99" }, { text: "0.5", value: "0.5" }] },
    ]);
    expect(warnings).toEqual([]);
    expect(edits.filter((e) => "path" in e && e.path.startsWith("/templating"))).toEqual([]);
    const props = (id: string) => [decl(p.declarations, id).className, decl(p.declarations, id).props];
    expect(props("variable:Filters")).toEqual([
      "AdhocVariable",
      {
        name: "Filters",
        datasource: { $decl: "datasource:prometheus:prom" },
        filters: [{ key: "namespace", operator: "=", value: "shop" }],
        defaultKeys: [{ text: "pod", value: "pod" }],
        allowCustomValue: false,
      },
    ]);
    expect(props("variable:by")).toEqual([
      "GroupByVariable",
      {
        name: "by",
        datasource: { $decl: "datasource:prometheus:prom" },
        options: ["pod", { text: "Node", value: "node" }],
        defaultValue: ["pod"],
        current: { text: ["node"], value: ["node"] },
      },
    ]);
    expect(props("variable:on")).toEqual(["SwitchVariable", { name: "on", enabled: true }]);
    expect(props("variable:q")).toEqual(["SwitchVariable", { name: "q", enabledValue: "0.99", disabledValue: "0.5" }]);
  });

  test("a switch whose current value is neither of its values starts off, and says so", () => {
    const { warnings, edits } = plan([{ type: "switch", name: "s", current: { text: "maybe", value: "maybe" }, options: [{ text: "true", value: "true" }, { text: "false", value: "false" }] }]);
    expect(warnings).toEqual(['variable "s": current is "maybe", neither the enabled nor the disabled value; the switch starts off']);
    expect(edits).toContainEqual({ op: "replace", path: "/templating/list/0/current", value: { text: "false", value: "false" } });
  });

  test("an ad hoc or group by variable with no datasource chant can refer to is left out", () => {
    const { warnings } = plan([{ type: "adhoc", name: "f", datasource: { type: "prometheus" }, filters: [] }]);
    expect(warnings).toContainEqual(expect.stringMatching(/^variable "f" is not carried: it has no datasource chant can refer to, and AdhocVariable needs one/));
  });

  test("an object query is carried as it is, with a definition that differs from its text", () => {
    const query = { qryType: 1, query: "label_values(job)", refId: "PrometheusVariableQueryEditor-VariableQuery" };
    const { plan: p, warnings, edits } = plan([
      { type: "query", name: "job", datasource: prom, query, definition: "label_values(job)" },
      { type: "query", name: "ns", datasource: { type: "cloudwatch", uid: "cw" }, query: { namespace: "AWS/EC2" }, definition: "Namespaces" },
    ]);
    expect(warnings).toEqual([]);
    expect(edits.filter((e) => "path" in e && e.path.startsWith("/templating"))).toEqual([]);
    expect(decl(p.declarations, "variable:job").props).toEqual({ name: "job", datasource: { $decl: "datasource:prometheus:prom" }, query });
    expect(decl(p.declarations, "variable:ns").props).toMatchObject({ query: { namespace: "AWS/EC2" }, definition: "Namespaces" });
  });

  test("keys at Grafana's default are dropped quietly; others are named", () => {
    const { warnings, edits } = plan([
      { type: "custom", name: "env", query: "a", allowCustomValue: true, valuesFormat: "csv", useTags: false, tagsQuery: "" },
      { type: "custom", name: "e2", query: "a", allowCustomValue: false },
    ]);
    expect(edits).toContainEqual({ op: "remove", path: "/templating/list/0/valuesFormat" });
    expect(warnings).toEqual([]);
  });

  test("carries allowCustomValue false and hide 3 on a variable", () => {
    const { plan: p, warnings } = plan([
      { type: "custom", name: "e2", query: "a", allowCustomValue: false, hide: 3 },
      { type: "datasource", name: "ds", query: "loki", allowCustomValue: false, hide: 1 },
    ]);
    expect(warnings).toEqual([]);
    expect(decl(p.declarations, "variable:e2").props).toEqual({ name: "e2", hide: "controlsMenu", values: ["a"], allowCustomValue: false });
    expect(decl(p.declarations, "variable:ds").props).toMatchObject({ hide: "valueOnly", pluginType: "loki", allowCustomValue: false });
  });

  test("a textbox's current value, and a visible constant, are named", () => {
    const { warnings } = plan([
      { type: "textbox", name: "t", query: "x", current: { text: "y", value: "y" } },
      { type: "constant", name: "c", query: "v", hide: 0 },
    ]);
    expect(warnings).toEqual([
      'variable "t": current is not carried (the box\'s value "y"; TextboxVariable starts at its default, "x")',
      'variable "c": hide is not 2: chant always writes a constant hidden, as Grafana shows it',
    ]);
  });
});

describe("panels and rows", () => {
  test("an expanded row owns the panels after it; a collapsed row the panels inside it", () => {
    const { plan } = planDashboard(
      dashboard({
        panels: [
          { type: "text", id: 1, title: "intro", gridPos: { x: 0, y: 0, w: 24, h: 3 } },
          { type: "row", id: 2, title: "Open", collapsed: false, gridPos: { x: 0, y: 3, w: 24, h: 1 }, panels: [] },
          { type: "stat", id: 3, title: "a", gridPos: { x: 0, y: 4, w: 6, h: 4 } },
          { type: "row", id: 4, title: "Shut", collapsed: true, gridPos: { x: 0, y: 8, w: 24, h: 1 }, panels: [{ type: "stat", id: 5, title: "b" }] },
        ],
      }),
    );
    expect(decl(plan.declarations, "dashboard").props!.panels).toEqual([{ $decl: "panel:0" }, { $decl: "row:0" }, { $decl: "row:1" }]);
    expect(decl(plan.declarations, "row:0").props).toEqual({ title: "Open", id: 2, gridPos: { y: 3 }, panels: [{ $decl: "panel:1" }] });
    expect(decl(plan.declarations, "row:1").props).toEqual({ title: "Shut", id: 4, collapsed: true, gridPos: { y: 8 }, panels: [{ $decl: "panel:2" }] });
    expect(plan.modules.map((m) => m.file)).toEqual(["panels", "row-open", "row-shut", "dashboard"]);
  });

  test("a row keeps the line it is on, even with an empty band above it (kube-prometheus nodes)", () => {
    const { plan, edits, warnings } = planDashboard(
      dashboard({
        panels: [
          { type: "stat", id: 1, title: "a", gridPos: { x: 0, y: 0, w: 24, h: 4 } },
          { type: "row", id: 2, title: "Late", collapsed: false, gridPos: { x: 0, y: 6, w: 24, h: 1 }, panels: [] },
          { type: "row", id: 3, title: "Bare", collapsed: false, gridPos: { y: 7 }, panels: [] },
        ],
      }),
    );
    expect(decl(plan.declarations, "row:0").props!.gridPos).toEqual({ y: 6 });
    expect(decl(plan.declarations, "row:1").props!.gridPos).toEqual({ y: 7 });
    // A row header is full width and one line high to Grafana, so filling those in is no change, and needs no warning.
    expect(edits).toContainEqual({ op: "replace", path: "/panels/2/gridPos", value: { h: 1, w: 24, x: 0, y: 7 } });
    expect(warnings).toEqual([]);
  });

  test("a gridPos without x or y has them written as 0; without h or w, with the schema's size and a warning", () => {
    const { plan, edits, warnings } = planDashboard(
      dashboard({
        panels: [
          { type: "stat", id: 1, title: "a", gridPos: { h: 7, w: 18, y: 0 } },
          { type: "stat", id: 2, title: "b", gridPos: { x: 18, y: 0 } },
        ],
      }),
    );
    expect(decl(plan.declarations, "panel:0").props!.gridPos).toEqual({ h: 7, w: 18, x: 0, y: 0 });
    expect(decl(plan.declarations, "panel:1").props!.gridPos).toEqual({ h: 9, w: 12, x: 18, y: 0 });
    expect(edits).toContainEqual({ op: "replace", path: "/panels/0/gridPos", value: { h: 7, w: 18, x: 0, y: 0 } });
    expect(warnings).toEqual(['panel "b" (id 2): gridPos.h and gridPos.w are missing, so the dashboard schema\'s default is written (h 9, w 12)']);
  });

  test("a panel with no gridPos is left to the build's auto-layout, with a warning (#3029)", () => {
    const { plan, warnings } = planDashboard(
      dashboard({
        panels: [
          { type: "stat", id: 1, title: "a" },
          { type: "stat", id: 2, title: "b", gridPos: { h: 4, w: 6, x: 0, y: 0 } },
        ],
      }),
    );
    expect(decl(plan.declarations, "panel:0").props!.gridPos).toBeUndefined();
    expect(warnings).toEqual(['panel "a" (id 1): gridPos is missing, so the build places the panel itself, which can differ from where Grafana would put it (#3029)']);
  });

  test("a panel with no datasource in a row with one stays without, as in Grafana, with no warning (#2983)", () => {
    const { plan, edits, warnings } = planDashboard(
      dashboard({
        panels: [
          { type: "row", id: 1, title: "R", collapsed: true, datasource: prom, panels: [{ type: "stat", id: 2, title: "s", gridPos: { h: 4, w: 6, x: 0, y: 0 }, targets: [{ refId: "A", expr: "up" }] }] },
        ],
      }),
    );
    expect(decl(plan.declarations, "panel:0").props!.datasource).toBeUndefined();
    expect(edits).toEqual([]);
    expect(warnings).toEqual([]);
  });

  describe("library panels (#3010)", () => {
    const burn = { uid: "lp", name: "Burn", kind: 1, model: { type: "stat", title: "Burn", targets: [{ refId: "A", datasource: prom, expr: "up" }] } };
    const ref = { id: 4, gridPos: { h: 6, w: 24, x: 0, y: 7 }, libraryPanel: { uid: "lp", name: "Burn" } };

    test("an element a panel places becomes a LibraryPanel, and the panel a LibraryPanelRef to it", () => {
      const { plan, warnings, edits } = planDashboard(dashboard({ __elements: { lp: burn }, panels: [ref] }));
      expect(decl(plan.declarations, "library-panel:lp")).toMatchObject({ className: "LibraryPanel", props: { name: "Burn", uid: "lp", panel: { $decl: "panel:0" } } });
      expect(decl(plan.declarations, "panel:0")).toMatchObject({ className: "StatPanel", property: true });
      expect(decl(plan.declarations, "panel:1")).toMatchObject({
        className: "LibraryPanelRef",
        props: { libraryPanel: { $decl: "library-panel:lp" }, id: 4, gridPos: ref.gridPos },
        property: true,
      });
      expect(plan.exports).toContain("library-panel:lp");
      expect(warnings).toEqual([]);
      expect(edits).toEqual([]);
    });

    test("a reference to a library panel the dashboard does not carry names it by { uid, name }, with a warning", () => {
      const { plan, warnings } = planDashboard(dashboard({ panels: [{ ...ref, title: "Burn", type: "library-panel-ref" }] }));
      expect(decl(plan.declarations, "panel:0").props).toEqual({ libraryPanel: { uid: "lp", name: "Burn" }, id: 4, gridPos: ref.gridPos, title: "Burn" });
      expect(warnings).toEqual([expect.stringMatching(/^panel "Burn" \(id 4\) places the library panel "Burn" \(uid lp\), which the dashboard does not carry/)]);
    });

    test("a reference's own panel keys, as Grafana 8 and 9 saved them, are named and left out", () => {
      const { warnings, edits } = planDashboard(dashboard({ __elements: { lp: burn }, panels: [{ ...ref, type: "stat", targets: [] }] }));
      expect(warnings).toEqual(["panel (untitled) (id 4): type and targets are not carried (Grafana draws a library panel from the library's copy, and does not read them from the reference)"]);
      expect(edits).toEqual([{ op: "remove", path: "/panels/0/type" }, { op: "remove", path: "/panels/0/targets" }]);
    });

    test("an element no panel places, and a library variable, are named and left out", () => {
      const { plan, warnings } = planDashboard(dashboard({ __elements: { lp: burn, v: { uid: "v", name: "env", kind: 2, model: {} } }, panels: [] }));
      expect(plan.declarations.map((d) => d.id)).toEqual(["dashboard"]);
      expect(warnings).toEqual([
        '__elements entry "v" is a library variable, which chant has no class for, so it is left out',
        'library panel "lp" is in __elements but no panel places it, so it is left out',
      ]);
    });

    test("a model's gridPos, id and libraryPanel are left out with no warning; a folderUid is named", () => {
      const model = { ...burn.model, id: 9, gridPos: { h: 1, w: 1, x: 0, y: 0 }, libraryPanel: { uid: "lp", name: "Burn" } };
      const { warnings, edits } = planDashboard(dashboard({ __elements: { lp: { ...burn, model, folderUid: "slos" } }, panels: [ref] }));
      expect(warnings).toEqual(['library panel "lp": folderUid is not carried (the uid of the folder it is kept in; give the LibraryPanel a folder)']);
      expect(edits.map((e) => ("path" in e ? e.path : "")).sort()).toEqual(["/__elements/lp/folderUid", "/__elements/lp/model/gridPos", "/__elements/lp/model/id", "/__elements/lp/model/libraryPanel"]);
    });
  });

  test("a panel type chant has no class for gets a definePanel", () => {
    const { plan } = planDashboard(dashboard({ panels: [{ type: "grafana-clock-panel", id: 1, title: "clock" }, { type: "grafana-clock-panel", id: 2, title: "clock 2" }] }));
    expect(plan.customClasses).toEqual([
      expect.objectContaining({ id: "panel-class:grafana-clock-panel", className: "GrafanaClockPanelPanel", factory: "definePanel", definition: { type: "grafana-clock-panel", className: "GrafanaClockPanelPanel", defaultSize: { w: 12, h: 8 } } }),
    ]);
    expect(decl(plan.declarations, "panel:1")).toMatchObject({ className: "GrafanaClockPanelPanel", customClass: "panel-class:grafana-clock-panel" });
  });

  test("a panel key no prop takes is named, unless it is at Grafana's default", () => {
    const { warnings } = planDashboard(dashboard({ panels: [{ type: "stat", id: 1, title: "s", gridPos: { h: 4, w: 6, x: 0, y: 0 }, transparent: false, cacheTimeout: null, libraryPanelX: 1 }] }));
    expect(warnings).toEqual(['panel "s" (id 1): libraryPanelX is not carried (no prop takes it)']);
  });
});

describe("the dashboard", () => {
  test("fields, the tooltip by name, and a timezone Grafana would read as the viewer's", () => {
    const { plan, warnings } = planDashboard(
      dashboard({ graphTooltip: 1, refresh: "30s", tags: ["a"], editable: true, id: 3, version: 9, iteration: 1, time: { from: "now-1h", to: "now" } }),
    );
    expect(decl(plan.declarations, "dashboard").props).toEqual({
      title: "T",
      uid: "t",
      tags: ["a"],
      time: { from: "now-1h", to: "now" },
      refresh: "30s",
      timezone: "",
      graphTooltip: "sharedCrosshair",
    });
    expect(warnings).toEqual([]);
    expect(plan.directory).toBe("t");
  });

  test("an older schemaVersion is carried, so Grafana still migrates it", () => {
    const { plan } = planDashboard(dashboard({ schemaVersion: 39 }));
    expect(decl(plan.declarations, "dashboard").props!.schemaVersion).toBe(39);
  });

  test("a dashboard with no uid is given one from its title", () => {
    const { plan, warnings } = planDashboard({ title: "My Board", schemaVersion: 42, panels: [] });
    expect(decl(plan.declarations, "dashboard").props!.uid).toBe("my-board");
    expect(warnings).toContain('dashboard: uid is missing, so the dashboard is given the uid "my-board", from its title');
  });

  test("the built-in annotation is Grafana's default and left out; any other is carried (#2953)", () => {
    const builtin = { builtIn: 1, datasource: { type: "datasource", uid: "grafana" }, enable: true, hide: true, iconColor: "rgba(0, 211, 255, 1)", name: "Annotations & Alerts", type: "dashboard" };
    const only = planDashboard(dashboard({ annotations: { list: [builtin] } }));
    expect(only.warnings).toEqual([]);
    expect(only.plan.declarations.find((d) => d.id === "dashboard")!.props!.annotations).toBeUndefined();
    const deploys = { name: "Deploys", datasource: { type: "prometheus", uid: "prom" }, iconColor: "red", expr: "changes(up[5m]) > 0", step: "60s", target: { refId: "Anno" } };
    const other = planDashboard(dashboard({ annotations: { list: [builtin, deploys, { name: "Off", enable: false, iconColor: "blue", hide: null }] } }));
    expect(other.warnings).toEqual(['annotation "Deploys": enable is missing, so it is written as true, which runs the query']);
    const props = other.plan.declarations.find((d) => d.id === "dashboard")!.props!;
    expect(props.annotations).toEqual([
      { name: "Deploys", datasource: { $decl: "datasource:prometheus:prom" }, iconColor: "red", expr: "changes(up[5m]) > 0", step: "60s", target: { refId: "Anno" } },
      { name: "Off", enable: false, iconColor: "blue" },
    ]);
    expect(other.plan.declarations).toContainEqual(expect.objectContaining({ id: "datasource:prometheus:prom", className: "ExternalDatasource" }));
    expect(other.edits).toContainEqual({ op: "replace", path: "/annotations/list/1/enable", value: true });
    expect(other.edits).toContainEqual({ op: "remove", path: "/annotations/list/2/hide" });
  });
});

describe("provisioning files", () => {
  test("a datasource provisioning file: one Datasource each, unknown keys named", () => {
    const ir = parse("apiVersion: 1\nprune: true\ndatasources:\n  - name: Prometheus\n    type: prometheus\n    url: http://prom:9090\n    password: x\nextra: 1\n");
    const { plan } = ir.resources[0].properties as unknown as PlanResourceProperties;
    expect(plan.declarations).toEqual([
      expect.objectContaining({ className: "Datasource", props: { name: "Prometheus", type: "prometheus", url: "http://prom:9090" } }),
    ]);
    expect(ir.warnings).toEqual(['datasource "Prometheus": password is not carried (no prop takes it)', "the provisioning file: extra is not carried (no prop takes it)"]);
  });

  test("a datasource provisioning file's prune and deleteDatasources become a DatasourceProvisioning (#2953)", () => {
    const pruned = parse("apiVersion: 1\nprune: true\ndatasources: []\n").resources[0].properties as unknown as PlanResourceProperties;
    expect(pruned.plan.declarations).toEqual([]);
    const kept = parse("apiVersion: 1\ndeleteDatasources:\n  - name: Old\n    orgId: 2\n  - name: Gone\ndatasources: []\n");
    const { plan } = kept.resources[0].properties as unknown as PlanResourceProperties;
    expect(plan.declarations).toEqual([
      expect.objectContaining({ className: "DatasourceProvisioning", props: { prune: false, deleteDatasources: [{ name: "Old", orgId: 2 }, { name: "Gone" }] } }),
    ]);
    expect(kept.warnings).toEqual([]);
  });

  test("a dashboard provisioning file: file providers only", () => {
    const ir = parse({ apiVersion: 1, providers: [{ name: "a", type: "file", options: { path: "/d" } }, { name: "b", type: "sqlite" }] });
    const { plan } = ir.resources[0].properties as unknown as PlanResourceProperties;
    expect(plan.declarations.map((d) => d.props)).toEqual([{ name: "a", path: "/d" }]);
    expect(ir.warnings).toEqual(['provider "b" is of type sqlite; chant writes file providers only, so it is left out']);
  });
});

describe("transformations (#2954)", () => {
  test("a transformation the types hold stays an object; any other is written with customTransformation()", () => {
    const transformations = [
      { id: "organize", options: { renameByName: { Value: "Requests" } } },
      { id: "sortBy", options: { fields: {}, sort: [{ field: "Pod" }] } },
      { id: "grafana-plugin-x", options: { a: 1 }, disabled: true },
      { options: {} },
    ];
    const { plan, warnings } = planDashboard(dashboard({ panels: [{ type: "table", id: 1, title: "t", gridPos: { x: 0, y: 0, w: 12, h: 8 }, transformations }] }));
    expect(decl(plan.declarations, "panel:0").props!.transformations).toEqual([
      { id: "organize", options: { renameByName: { Value: "Requests" } } },
      { $call: "customTransformation", args: ["sortBy", { fields: {}, sort: [{ field: "Pod" }] }] },
      { $call: "customTransformation", args: ["grafana-plugin-x", { a: 1 }, { disabled: true }] },
    ]);
    expect(warnings).toEqual([
      'panel "t" (id 1): transformation 2 is written with customTransformation(), untyped: the sortBy transformer takes no option "fields".',
      'panel "t" (id 1): transformation 3 is written with customTransformation(), untyped: "grafana-plugin-x" is not a transformer Grafana v13.2.2 registers.',
      'panel "t" (id 1): transformation 4 has no id, so Grafana skips it; it is not carried.',
    ]);
  });
});
