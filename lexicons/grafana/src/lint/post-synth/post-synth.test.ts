import { describe, expect, test } from "vitest";
import { makePostSynthCtxFromFiles, makePostSynthCtx } from "@intentius/chant-test-utils";
import type { PostSynthCheck } from "@intentius/chant/lint/post-synth";
import type { Declarable } from "@intentius/chant/declarable";
import { grafanaSerializer } from "../../serializer";
import { Datasource } from "../../datasource";
import { Dashboard } from "../../dashboard";
import { Row, StatPanel, TimeSeriesPanel, TablePanel } from "../../panels";
import { PromQuery, TempoQuery } from "../../query";
import { DatasourceVariable, QueryVariable } from "../../variables";
import { graf101 } from "./graf101";
import { graf102 } from "./graf102";
import { graf103 } from "./graf103";
import { graf104 } from "./graf104";
import { graf105 } from "./graf105";
import { graf106 } from "./graf106";
import { graf107 } from "./graf107";

/** Serialize entities the way a build does and hand the files to the harness. */
function ctxOf(entities: Record<string, Declarable>) {
  const out = grafanaSerializer.serialize(new Map(Object.entries(entities)));
  if (typeof out === "string") throw new Error("expected files");
  return makePostSynthCtxFromFiles("grafana", out.files!, out.primary, new Map(Object.entries(entities)));
}

/** A context from hand-written dashboard JSON and datasources, for shapes the typed API can't produce. */
function ctxOfJson(dashboard: Record<string, unknown>, datasources: Array<Record<string, unknown>> = []) {
  const files: Record<string, string> = { "dashboards/d.json": JSON.stringify(dashboard) };
  if (datasources.length > 0) files["provisioning/datasources/chant.yaml"] = JSON.stringify({ apiVersion: 1, datasources });
  return makePostSynthCtxFromFiles("grafana", files, "{}");
}

function ids(check: PostSynthCheck, ctx: ReturnType<typeof ctxOf>) {
  return check.check(ctx).map((d) => [d.checkId, d.severity]);
}

const prometheus = new Datasource({ name: "Prometheus", type: "prometheus" });
const tempo = new Datasource({ name: "Tempo", type: "tempo" });
const up = new PromQuery({ expr: "sum(up)" });

function panelJson(extra: Record<string, unknown>) {
  return { type: "stat", id: 1, title: "p", gridPos: { x: 0, y: 0, w: 6, h: 4 }, options: {}, fieldConfig: { defaults: {}, overrides: [] }, ...extra };
}

function dashboardJson(panels: unknown[], variables: unknown[] = [], extra: Record<string, unknown> = {}) {
  return { uid: "d", title: "D", schemaVersion: 42, annotations: { list: [] }, templating: { list: variables }, panels, ...extra };
}

describe("GRAF101: undeclared datasource", () => {
  test("flags a ref to a uid nobody declares", () => {
    const panel = new StatPanel({ datasource: { type: "prometheus", uid: "mimir" }, targets: [up] });
    const diags = graf101.check(ctxOf({ prometheus, d: new Dashboard({ title: "D", panels: [panel] }) }));
    expect(diags.map((d) => d.checkId)).toEqual(["GRAF101", "GRAF101"]);
    expect(diags[0].message).toContain('"mimir"');
    expect(diags[0].severity).toBe("error");
  });

  test("warns about queries with no datasource at all", () => {
    const diags = graf101.check(ctxOf({ prometheus, d: new Dashboard({ title: "D", panels: [new StatPanel({ targets: [up] })] }) }));
    expect(diags.map((d) => [d.checkId, d.severity])).toEqual([["GRAF101", "warning"]]);
  });

  test("flags a query variable on an undeclared datasource", () => {
    const v = new QueryVariable({ name: "job", datasource: { type: "prometheus", uid: "gone" }, query: "label_values(job)" });
    expect(ids(graf101, ctxOf({ prometheus, d: new Dashboard({ title: "D", variables: [v] }) }))).toEqual([["GRAF101", "error"]]);
  });

  test("passes declared datasources, datasource variables and Grafana's pseudo-datasources", () => {
    const ds = new DatasourceVariable({ name: "ds", pluginType: "prometheus" });
    const mixed = new TablePanel({ targets: [new PromQuery({ expr: "up", datasource: prometheus }), new TempoQuery({ query: "{}", datasource: tempo })] });
    const d = new Dashboard({ title: "D", variables: [ds], panels: [new StatPanel({ datasource: prometheus, targets: [up] }), new StatPanel({ datasource: ds, targets: [up] }), mixed] });
    expect(graf101.check(ctxOf({ prometheus, tempo, d }))).toEqual([]);
  });

  test("is silent when the build declares no datasource (another build root, chant #1939)", () => {
    const panel = new StatPanel({ datasource: { type: "prometheus", uid: "elsewhere" }, targets: [up] });
    expect(graf101.check(ctxOf({ d: new Dashboard({ title: "D", panels: [panel] }) }))).toEqual([]);
  });
});

describe("GRAF102: datasource type mismatch", () => {
  test("flags a query sent to a datasource of another type", () => {
    const panel = new StatPanel({ datasource: { type: "prometheus", uid: "tempo" }, targets: [up] });
    const diags = graf102.check(ctxOf({ tempo, d: new Dashboard({ title: "D", panels: [panel] }) }));
    expect(diags.length).toBeGreaterThanOrEqual(1);
    expect(diags[0].message).toContain("which is tempo");
  });

  test("flags a ref through a datasource variable of another plugin type", () => {
    const dash = dashboardJson(
      [panelJson({ datasource: { type: "prometheus", uid: "${ds}" }, targets: [{ refId: "A", expr: "up", datasource: { type: "prometheus", uid: "${ds}" } }] })],
      [{ type: "datasource", name: "ds", query: "loki" }],
    );
    const diags = graf102.check(ctxOfJson(dash, [{ name: "Loki", type: "loki", uid: "loki" }]));
    expect(diags[0].message).toContain('variable "ds" chooses among loki');
  });

  test("passes matching types", () => {
    expect(graf102.check(ctxOf({ prometheus, d: new Dashboard({ title: "D", panels: [new StatPanel({ datasource: prometheus, targets: [up] })] }) }))).toEqual([]);
  });
});

describe("GRAF103: undeclared variables", () => {
  test("flags $name, ${name} and [[name]] the dashboard doesn't declare", () => {
    const q = new PromQuery({ expr: 'rate(x{job="$job", env="${env:regex}"}[$__rate_interval])', legendFormat: "[[instance]]" });
    const diags = graf103.check(ctxOf({ d: new Dashboard({ title: "D", panels: [new StatPanel({ title: "for $svc", datasource: prometheus, targets: [q] })] }) }));
    expect(diags.map((d) => d.message.match(/uses \$(\w+)/)![1]).sort()).toEqual(["env", "instance", "job", "svc"]);
  });

  test("flags an undeclared repeat variable and variable query reference", () => {
    const v = new QueryVariable({ name: "instance", datasource: prometheus, query: 'label_values(up{job="$job"}, instance)' });
    const diags = graf103.check(ctxOf({ d: new Dashboard({ title: "D", variables: [v], panels: [new StatPanel({ repeat: "pod" })] }) }));
    expect(diags.map((d) => d.message)).toEqual([expect.stringContaining("repeat uses $pod"), expect.stringContaining('variable "instance" query uses $job')]);
  });

  test("passes declared variables and Grafana's built-ins", () => {
    const job = new QueryVariable({ name: "job", datasource: prometheus, query: "label_values(up, job)" });
    const q = new PromQuery({ expr: 'rate(x{job="$job"}[$__rate_interval]) / $__range_s', legendFormat: "{{job}}" });
    const d = new Dashboard({ title: "D", variables: [job], panels: [new StatPanel({ datasource: prometheus, targets: [q], repeat: job })] });
    expect(graf103.check(ctxOf({ d }))).toEqual([]);
  });
});

describe("GRAF104: duplicates", () => {
  test("flags duplicate dashboard uids, datasource names and panel ids", () => {
    const again = new Datasource({ name: "Prometheus", type: "prometheus", uid: "prom-2" });
    const d1 = new Dashboard({ title: "A", uid: "same", panels: [new StatPanel({ id: 7 }), new StatPanel({ id: 7 })] });
    const d2 = new Dashboard({ title: "B", uid: "same" });
    const messages = graf104.check(ctxOf({ prometheus, again, d1, d2 })).map((d) => d.message);
    expect(messages).toEqual([
      expect.stringContaining('share the uid "same"'),
      expect.stringContaining('share the name "Prometheus"'),
      expect.stringContaining("2 panels with id 7"),
    ]);
  });

  test("flags duplicate refIds and variable names", () => {
    const dash = dashboardJson(
      [panelJson({ targets: [{ refId: "A", expr: "a" }, { refId: "A", expr: "b" }] })],
      [{ type: "textbox", name: "q" }, { type: "textbox", name: "q" }],
    );
    expect(graf104.check(ctxOfJson(dash)).map((d) => d.message)).toEqual([
      expect.stringContaining('variable "q" 2 times'),
      expect.stringContaining('refId "A"'),
    ]);
  });

  test("passes unique ids", () => {
    expect(graf104.check(ctxOf({ prometheus, tempo, a: new Dashboard({ title: "A", panels: [new StatPanel(), new StatPanel()] }), b: new Dashboard({ title: "B" }) }))).toEqual([]);
  });
});

describe("GRAF105: grid", () => {
  test("flags a panel past column 24 as an error and an overlap as a warning", () => {
    const d = new Dashboard({
      title: "D",
      panels: [
        new StatPanel({ title: "wide", gridPos: { x: 20, y: 0, w: 8, h: 4 } }),
        new TimeSeriesPanel({ title: "a", gridPos: { x: 0, y: 10, w: 12, h: 8 } }),
        new TimeSeriesPanel({ title: "b", gridPos: { x: 6, y: 12, w: 12, h: 8 } }),
      ],
    });
    expect(ids(graf105, ctxOf({ d }))).toEqual([
      ["GRAF105", "error"],
      ["GRAF105", "warning"],
    ]);
  });

  test("compares a collapsed row's panels with each other only", () => {
    const d = new Dashboard({
      title: "D",
      panels: [new StatPanel({ title: "top" }), new Row({ title: "r", collapsed: true, panels: [new StatPanel({ gridPos: { x: 0, y: 0, w: 6, h: 4 } })] })],
    });
    expect(graf105.check(ctxOf({ d }))).toEqual([]);
  });

  test("passes a dashboard laid out by chant", () => {
    const panels = [new StatPanel(), new TimeSeriesPanel(), new Row({ title: "r", panels: [new TablePanel(), new TablePanel(), new TablePanel()] })];
    expect(graf105.check(ctxOf({ d: new Dashboard({ title: "D", panels }) }))).toEqual([]);
  });
});

describe("GRAF106: uids and titles", () => {
  test("flags an over-long uid, a bad datasource uid and an empty title", () => {
    const bad = new Datasource({ name: "Bad", type: "prometheus", uid: "has space" });
    const d = new Dashboard({ title: "", uid: "x".repeat(41) });
    expect(graf106.check(ctxOf({ bad, d })).map((x) => x.message)).toEqual([
      expect.stringContaining("has uid"),
      expect.stringContaining("has no title"),
      expect.stringContaining('Datasource "Bad"'),
    ]);
  });

  test("passes valid uids", () => {
    expect(graf106.check(ctxOf({ prometheus, d: new Dashboard({ title: "Fine", uid: "svc_overview-1" }) }))).toEqual([]);
  });
});

describe("GRAF107: the pinned schema", () => {
  test("flags an unknown dashboard key, a bad panel option and an unknown query field", () => {
    const dash = dashboardJson(
      [panelJson({ options: { graphMode: "sparkline" }, datasource: { type: "prometheus", uid: "p" }, targets: [{ refId: "A", expr: "up", exprr: "typo" }] })],
      [],
      { owner: "team-a" },
    );
    const messages = graf107.check(ctxOfJson(dash)).map((d) => d.message);
    expect(messages).toEqual([
      expect.stringContaining('must NOT have additional properties ("owner")'),
      expect.stringContaining("/panels/0/options/graphMode: must be equal to one of the allowed values"),
      expect.stringContaining('/panels/0/targets/0: must NOT have additional properties ("exprr")'),
    ]);
  });

  test("flags a row and a panel missing what the schema requires", () => {
    const dash = dashboardJson([{ type: "row", title: "r" }, { title: "no type" }]);
    const messages = graf107.check(ctxOfJson(dash)).map((d) => d.message);
    expect(messages.some((m) => m.includes("/panels/0: must have required property 'collapsed'"))).toBe(true);
    expect(messages.some((m) => m.includes("/panels/1: must have required property 'type'"))).toBe(true);
  });

  test("passes everything the typed API emits", () => {
    const d = new Dashboard({ title: "D", panels: [new StatPanel({ datasource: prometheus, targets: [up], options: { graphMode: "none" } })] });
    expect(graf107.check(ctxOf({ prometheus, d }))).toEqual([]);
  });

  test("checks a dashboard in another lexicon's output too", () => {
    const dash = dashboardJson([panelJson({ options: { colorMode: "rainbow" } })]);
    const ctx = makePostSynthCtx("k8s", JSON.stringify(dash));
    expect(graf107.check(ctx).map((d) => d.checkId)).toEqual(["GRAF107"]);
  });
});
