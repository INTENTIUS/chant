/**
 * Reading v2 dashboards (#2947): the key tables against the vendored
 * dashboardv2 schema, the conversion against Grafana's own v1 read of the
 * same dashboard, and a warning for everything v2 says that the classic
 * model cannot.
 */

import { describe, expect, test } from "vitest";
import { loadVendoredSchema } from "../spec/schemas";
import { normalizeDashboard } from "./normalize";
import { parseGrafana, type DashboardResourceMetadata } from "./parser";
import { V2_KEYS, lossyV1Read, readV2Dashboard } from "./v2";
import { LOSSY_V1_EXPORT, V2_EXPORTS, read } from "./testdata/fixtures";

type Json = Record<string, unknown>;

const json = (file: string): Json => JSON.parse(read(file)) as Json;
const TABS = "exports/grafana-13.2.2/tabs.v2-resource.json";
const CHECKOUT = "exports/grafana-13.2.2/checkout.v2-resource.json";

/** A bare v2 spec with one grid panel, for the synthetic cases. */
function spec(over: Json = {}): Json {
  return {
    title: "Synthetic",
    annotations: [],
    cursorSync: "Off",
    links: [],
    preload: false,
    tags: [],
    variables: [],
    timeSettings: { from: "now-1h", to: "now", autoRefresh: "", autoRefreshIntervals: [], hideTimepicker: false, fiscalYearStartMonth: 0 },
    elements: { "panel-1": panel(1, "One") },
    layout: grid(["panel-1"]),
    ...over,
  };
}

function panel(id: number, title: string, extra: Json = {}): Json {
  return {
    kind: "Panel",
    spec: {
      id,
      title,
      description: "",
      links: [],
      data: {
        kind: "QueryGroup",
        spec: {
          queries: [
            {
              kind: "PanelQuery",
              spec: {
                query: { kind: "DataQuery", group: "prometheus", version: "v0", datasource: { name: "prom" }, spec: { expr: "up" } },
                refId: "A",
                hidden: false,
              },
            },
          ],
          transformations: [],
          queryOptions: {},
        },
      },
      vizConfig: { kind: "VizConfig", group: "timeseries", version: "", spec: { options: {}, fieldConfig: { defaults: {}, overrides: [] } } },
      ...extra,
    },
  };
}

function grid(names: string[], extra: Json = {}): Json {
  return {
    kind: "GridLayout",
    spec: {
      items: names.map((name, i) => ({ kind: "GridLayoutItem", spec: { x: 0, y: i * 8, width: 24, height: 8, element: { kind: "ElementReference", name }, ...extra } })),
    },
  };
}

describe("the key tables and the vendored dashboardv2 schema", () => {
  const defs = loadVendoredSchema("dashboardv2").definitions as Record<string, { properties?: Json }>;

  for (const [def, table] of Object.entries(V2_KEYS)) {
    test(`${def}: every key the schema defines is carried or reported, and no other`, () => {
      expect(defs[def], def).toBeDefined();
      const schemaKeys = Object.keys(defs[def].properties ?? {}).sort();
      expect([...table.carried, ...Object.keys(table.reported)].sort()).toEqual(schemaKeys);
    });
  }

  test("every variable kind the schema has is read", () => {
    const kinds = (defs.VariableKind as unknown as { oneOf: Array<{ $ref: string }> }).oneOf.map((r) => r.$ref.replace("#/definitions/", "").replace(/Kind$/, "Spec"));
    for (const spec of kinds) expect(V2_KEYS[spec], spec).toBeDefined();
  });

  test("every layout kind the schema has is read", () => {
    const layouts = (defs.Dashboard.properties!.layout as { oneOf: Array<{ $ref: string }> }).oneOf.map((r) => r.$ref.replace("#/definitions/", ""));
    expect(layouts.sort()).toEqual(["AutoGridLayoutKind", "GridLayoutKind", "RowsLayoutKind", "TabsLayoutKind"]);
  });
});

describe("a v2 dashboard read as classic JSON", () => {
  test("gives what Grafana 13.2.2 serves for the same dashboard at v1, but for what is reported", () => {
    const { dashboard } = readV2Dashboard(json(TABS));
    const grafana = (json(LOSSY_V1_EXPORT).spec as Json) ?? {};
    // "Show in controls menu" is hide 3, in Grafana's own v1 and in the read.
    expect(normalizeDashboard(dashboard)).toEqual(normalizeDashboard({ ...structuredClone(grafana), uid: "chant-fx-tabs" }));
  });

  test("the checkout V2 Resource export carries every panel and variable the Classic export of it has", () => {
    const { dashboard } = readV2Dashboard(json(CHECKOUT));
    const classic = json("exports/grafana-13.2.2/checkout.json");
    const leaves = (d: Json): Json[] => (d.panels as Json[]).flatMap((p) => (p.type === "row" ? ((p.panels as Json[] | undefined) ?? []) : [p]));
    const byId = (d: Json) => new Map(leaves(normalizeDashboard(d)).map((p) => [p.id, p]));
    // v2 keeps a threshold's base step as value: null, which the classic export leaves out.
    const strip = (v: unknown): unknown => JSON.parse(JSON.stringify(v, (k, x) => (k === "value" && x === null ? undefined : x)));
    const mine = byId(dashboard);
    const theirs = byId(classic);
    expect([...mine.keys()].sort()).toEqual([...theirs.keys()].sort());
    for (const [id, p] of theirs) {
      const q = mine.get(id)!;
      for (const key of ["type", "title", "options", "targets", "transformations", "datasource", "links", "repeat", "repeatDirection", "maxPerRow"]) {
        expect({ id, key, value: q[key] }).toEqual({ id, key, value: p[key] });
      }
      expect(strip(q.fieldConfig)).toEqual(strip(p.fieldConfig));
    }
    const vars = (d: Json) =>
      ((normalizeDashboard(d).templating as { list: Json[] }).list).map(({ current: _c, ...rest }) => rest);
    expect(vars(dashboard).map((v) => v.name)).toEqual(vars(classic).map((v) => v.name));
    for (const key of ["title", "tags", "links", "time", "timezone", "editable"]) expect({ key, v: dashboard[key] }).toEqual({ key, v: classic[key] });
    // A collapsed row keeps its repeat, and the panel after it in the Classic export sits inside it in v2.
    const row = (dashboard.panels as Json[]).find((p) => p.type === "row")!;
    expect(row).toMatchObject({ title: "Details for $job", collapsed: true, repeat: "job" });
    expect((row.panels as Json[]).map((p) => p.id)).toEqual([4, 5]);
  });

  test("names every v2-only feature of the tabs dashboard", () => {
    const { warnings } = readV2Dashboard(json(TABS));
    expect(warnings).toEqual([
      'layout: the dashboard\'s tabs "Overview" and "Details" become expanded rows, since a classic dashboard has no tabs: every tab\'s panels show on one page, one after another',
      'layout: the tab "Overview" is an auto grid, which a classic dashboard does not have. Its 2 panels are placed on a fixed grid, 2 to a row at 12x5, as Grafana places them when it reads the dashboard at v1, and no longer resize with the screen',
      'layout: a panel in the tab "Overview": conditionalRendering is not carried (conditional rendering has no classic form, so the panel always shows)',
      'layout: the rows inside the tab "Details" come after its row as rows of their own, since classic rows do not nest',
      'layout: the row "Logs": fillScreen is not carried (a classic row does not stretch to fill the screen)',
      'layout: the row "Logs": conditionalRendering is not carried (conditional rendering has no classic form, so the row always shows)',
    ]);
  });

  test("an export with nothing v2-only reads without a v2 warning", () => {
    expect(readV2Dashboard(json(CHECKOUT)).warnings).toEqual([]);
  });

  test("tabs become rows, in order, and an auto grid gets Grafana's fixed positions", () => {
    const panels = readV2Dashboard(json(TABS)).dashboard.panels as Json[];
    expect(panels.map((p) => [p.type, p.id, p.title, p.gridPos])).toEqual([
      ["row", 5, "Overview", { h: 1, w: 24, x: 0, y: 0 }],
      ["stat", 1, "Availability", { h: 5, w: 12, x: 0, y: 1 }],
      ["timeseries", 2, "Request rate", { h: 5, w: 12, x: 12, y: 1 }],
      ["row", 6, "Details", { h: 1, w: 24, x: 0, y: 6 }],
      ["row", 7, "Latency ($env)", { h: 1, w: 24, x: 0, y: 7 }],
      ["timeseries", 3, "p99 latency", { h: 8, w: 24, x: 0, y: 8 }],
      ["row", 8, "Logs", { h: 1, w: 24, x: 0, y: 16 }],
    ]);
    expect(panels[4].repeat).toBe("env");
    expect((panels[6].panels as Json[]).map((p) => [p.id, p.gridPos])).toEqual([[4, { h: 10, w: 24, x: 0, y: 17 }]]);
    // Query options, a hidden query and a disabled transformation become the classic keys.
    expect(panels[2]).toMatchObject({ maxDataPoints: 500, interval: "30s", timeFrom: "1h", pluginVersion: "13.2.2" });
    expect((panels[2].targets as Json[])[1]).toMatchObject({ refId: "B", hide: true });
    expect(panels[2].transformations).toEqual([{ id: "organize", disabled: true, options: { renameByName: { total: "all" } } }]);
  });

  test("a key the schema does not have is reported", () => {
    const s = spec({ sparkle: true });
    (s.elements as Json)["panel-1"] = panel(1, "One", { glow: 1 });
    expect(readV2Dashboard(s).warnings).toEqual([
      "dashboard: sparkle is not carried (not a key the dashboardv2 schema at the pin has)",
      'panel "One" (id 1): glow is not carried (not a key the dashboardv2 schema at the pin has)',
    ]);
  });

  test("an element no layout places, and one placed twice, are reported", () => {
    const s = spec({ elements: { "panel-1": panel(1, "One"), "panel-2": panel(2, "Two") }, layout: grid(["panel-1", "panel-1"]) });
    const { dashboard, warnings } = readV2Dashboard(s);
    expect((dashboard.panels as Json[]).map((p) => p.id)).toEqual([1]);
    expect(warnings).toEqual([
      'layout: the dashboard places the element "panel-1" a second time; a classic dashboard holds each panel once, so the second is left out',
      'elements: "panel-2" is not placed in the layout, so Grafana does not show it and it is left out',
    ]);
  });

  test("a hidden row header is fine first, and reported after another row", () => {
    const row = (title: string, name: string, hideHeader: boolean) => ({ kind: "RowsLayoutRow", spec: { title, collapse: false, hideHeader, layout: grid([name]) } });
    const s = spec({
      elements: { "panel-1": panel(1, "One"), "panel-2": panel(2, "Two"), "panel-3": panel(3, "Three") },
      layout: { kind: "RowsLayout", spec: { rows: [row("", "panel-1", true), row("B", "panel-2", false), row("", "panel-3", true)] } },
    });
    const { dashboard, warnings } = readV2Dashboard(s);
    expect((dashboard.panels as Json[]).map((p) => [p.type, p.id, (p.gridPos as Json).y])).toEqual([
      ["timeseries", 1, 0],
      ["row", 4, 8],
      ["timeseries", 2, 9],
      ["timeseries", 3, 17],
    ]);
    expect(warnings).toEqual([
      'layout: the row (untitled) has a hidden header, which a classic dashboard has only for the panels above its first row; here its panels follow the row before them, so they become part of that row',
    ]);
  });

  test("a library panel element becomes a libraryPanel reference", () => {
    const s = spec({ elements: { "panel-1": { kind: "LibraryPanel", spec: { id: 1, title: "Shared", libraryPanel: { uid: "lp", name: "Shared" } } } } });
    expect((readV2Dashboard(s).dashboard.panels as Json[])[0]).toEqual({ id: 1, title: "Shared", gridPos: { h: 8, w: 24, x: 0, y: 0 }, libraryPanel: { uid: "lp", name: "Shared" } });
  });

  test("a grid item's repeat, a legacy string query and v2beta1 transformations", () => {
    const p = panel(1, "One");
    const data = ((p.spec as Json).data as Json).spec as Json;
    (((data.queries as Json[])[0].spec as Json).query as Json).spec = { __legacyStringValue: "up", refId: "A" };
    data.transformations = [{ kind: "reduce", spec: { id: "reduce", options: { reducers: ["max"] } } }];
    const s = spec({ elements: { "panel-1": p }, layout: grid(["panel-1"], { repeat: { mode: "variable", value: "env", direction: "v", maxPerRow: 4 } }) });
    const out = (readV2Dashboard(s).dashboard.panels as Json[])[0];
    expect(out).toMatchObject({ repeat: "env", repeatDirection: "v", maxPerRow: 4, transformations: [{ id: "reduce", options: { reducers: ["max"] } }] });
    expect(out.targets).toEqual([{ query: "up", refId: "A", datasource: { type: "prometheus", uid: "prom" } }]);
  });

  test("an auto grid with custom row heights rounds pixels up to grid units, as Grafana does", () => {
    const s = spec({
      layout: { kind: "AutoGridLayout", spec: { columnWidthMode: "standard", rowHeightMode: "custom", rowHeight: 200, items: [{ kind: "AutoGridLayoutItem", spec: { element: { kind: "ElementReference", name: "panel-1" } } }] } },
    });
    expect((readV2Dashboard(s).dashboard.panels as Json[])[0].gridPos).toEqual({ h: 6, w: 8, x: 0, y: 0 });
  });

  test("v2alpha1 is refused, with where to read it instead", () => {
    expect(() => readV2Dashboard({ apiVersion: "dashboard.grafana.app/v2alpha1", kind: "Dashboard", metadata: { name: "x" }, spec: spec() })).toThrow(
      /dashboard\.grafana\.app\/v2alpha1 dashboard; chant reads v2 and v2beta1/,
    );
  });

  test("a folder annotation is reported", () => {
    const r = readV2Dashboard({ apiVersion: "dashboard.grafana.app/v2", kind: "Dashboard", metadata: { name: "x", annotations: { "grafana.app/folder": "ops" } }, spec: spec() });
    expect(r.warnings).toEqual(['metadata: the folder "ops" is not carried (a dashboard\'s folder is set where it is provisioned)']);
    expect(r.dashboard.uid).toBe("x");
  });
});

describe("the parser", () => {
  for (const file of V2_EXPORTS) {
    test(`imports ${file}, with the classic form as the round trip's source`, () => {
      const ir = parseGrafana(read(file));
      expect(ir.resources).toHaveLength(1);
      expect(ir.warnings?.[0]).toMatch(/^This is a v2 dashboard \(dashboard\.grafana\.app\/v2\)\. chant builds classic \(v1\) dashboard JSON/);
      const meta = ir.resources[0].metadata as unknown as DashboardResourceMetadata;
      expect(meta.v2).toEqual(json(file));
      expect(meta.source).toEqual(readV2Dashboard(json(file)).dashboard);
    });
  }

  test("a bare v2 spec imports too", () => {
    const ir = parseGrafana(JSON.stringify(spec()));
    expect(ir.resources).toHaveLength(1);
    expect(ir.warnings?.[0]).toMatch(/^This is a v2 dashboard\. /);
  });

  test("a v1 read of a dashboard stored as v2 is refused", () => {
    const ir = parseGrafana(read(LOSSY_V1_EXPORT));
    expect(ir.resources).toEqual([]);
    expect(ir.warnings).toEqual([
      expect.stringMatching(
        /^Not imported: Grafana stores this dashboard as v2 and converted it down to serve it at dashboard\.grafana\.app\/v1, .* Read the dashboard at dashboard\.grafana\.app\/v2 .* acceptLossyV1\.$/,
      ),
    ]);
  });

  test("with acceptLossyV1 it is imported, and the warning says what it is", () => {
    const ir = parseGrafana(read(LOSSY_V1_EXPORT), { acceptLossyV1: true });
    expect(ir.resources).toHaveLength(1);
    expect(ir.warnings?.[0]).toMatch(/^Grafana stores this dashboard as v2, and this dashboard\.grafana\.app\/v1 copy is a lossy down-conversion of it/);
  });

  test("a failed conversion is refused the same way", () => {
    const resource = { ...json(LOSSY_V1_EXPORT), status: { conversion: { failed: true, storedVersion: "v2" } } };
    expect(parseGrafana(JSON.stringify(resource)).warnings?.[0]).toMatch(/^Not imported: Grafana could not convert it from v2 \(status\.conversion\.failed\)/);
  });

  test("a v1 read of a dashboard stored as v0 or v1 is not lossy", () => {
    const resource = { ...json(LOSSY_V1_EXPORT), status: { conversion: { failed: false, storedVersion: "v0alpha1" } } };
    expect(lossyV1Read(resource)).toBeUndefined();
    expect(lossyV1Read(json(LOSSY_V1_EXPORT))).toEqual({ apiVersion: "dashboard.grafana.app/v1", storedVersion: "v2", failed: false });
    expect(parseGrafana(JSON.stringify(resource)).resources).toHaveLength(1);
  });
});
