import { describe, expect, test } from "vitest";
import { readdirSync, readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { makePostSynthCtxFromFiles, makePostSynthCtx } from "@intentius/chant-test-utils";
import type { PostSynthCheck } from "@intentius/chant/lint/post-synth";
import type { Declarable } from "@intentius/chant/declarable";
import { grafanaSerializer } from "../../serializer";
import { Datasource, ExternalDatasource } from "../../datasource";
import { Dashboard, DashboardProvider } from "../../dashboard";
import { Row, StatPanel, TimeSeriesPanel, TablePanel, TextPanel } from "../../panels";
import { LokiQuery, PromQuery, TempoQuery } from "../../query";
import { DatasourceVariable, QueryVariable } from "../../variables";
import { graf101 } from "./graf101";
import { graf102 } from "./graf102";
import { graf103 } from "./graf103";
import { graf104 } from "./graf104";
import { graf105 } from "./graf105";
import { graf106 } from "./graf106";
import { graf107 } from "./graf107";
import { graf108 } from "./graf108";
import { graf109 } from "./graf109";
import { prometheusQueries } from "../../promql-check";
import { knownDatasources } from "../../datasource-refs";

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

  test("warns once per dashboard when the build declares no datasource, so nothing can be checked", () => {
    const panel = new StatPanel({ datasource: { type: "prometheus", uid: "elsewhere" }, targets: [up] });
    const other = new StatPanel({ datasource: { type: "prometheus", uid: "elsewhere" }, targets: [up] });
    const diags = graf101.check(ctxOf({ d: new Dashboard({ title: "D", panels: [panel, other] }) }));
    expect(diags.map((d) => [d.checkId, d.severity])).toEqual([["GRAF101", "warning"]]);
    expect(diags[0].message).toContain('datasource uid "elsewhere"');
    expect(diags[0].message).toContain("ExternalDatasource");
  });

  test("says nothing when the build declares no datasource and the dashboard names none", () => {
    const panel = new TextPanel({ options: { content: "hi", mode: "markdown" } });
    expect(graf101.check(ctxOf({ d: new Dashboard({ title: "D", panels: [panel] }) }))).toEqual([]);
  });

  test("resolves entity and { type, uid } refs to an ExternalDatasource, and never provisions it", () => {
    const mimir = new ExternalDatasource({ type: "prometheus", uid: "mimir", name: "Mimir" });
    const d = new Dashboard({
      title: "D",
      panels: [new StatPanel({ datasource: mimir, targets: [up] }), new StatPanel({ datasource: { type: "prometheus", uid: "mimir" }, targets: [up] })],
      variables: [new QueryVariable({ name: "job", datasource: mimir, query: "label_values(job)" })],
    });
    const entities = { mimir, prometheus, d };
    expect(graf101.check(ctxOf(entities))).toEqual([]);
    expect(graf102.check(ctxOf(entities))).toEqual([]);
    const out = grafanaSerializer.serialize(new Map(Object.entries(entities))) as { primary: string; files: Record<string, string> };
    expect(out.files["provisioning/datasources/chant.yaml"]).not.toContain("mimir");
    expect(JSON.parse(out.primary).externalDatasources).toEqual([{ type: "prometheus", uid: "mimir", name: "Mimir" }]);
  });

  test("an ExternalDatasource alone is enough to check references", () => {
    const mimir = new ExternalDatasource({ type: "prometheus", uid: "mimir" });
    const d = new Dashboard({ title: "D", panels: [new StatPanel({ datasource: { type: "prometheus", uid: "typo" }, targets: [up] })] });
    const diags = graf101.check(ctxOf({ mimir, d }));
    expect(diags.map((x) => [x.checkId, x.severity])).toEqual([
      ["GRAF101", "error"],
      ["GRAF101", "error"],
    ]);
    expect(diags[0].message).toContain('Declared: "mimir"');
  });

  test("flags a DatasourceVariable whose plugin type no declared datasource has", () => {
    const ds = new DatasourceVariable({ name: "logs", pluginType: "loki" });
    const diags = graf101.check(ctxOf({ prometheus, d: new Dashboard({ title: "D", variables: [ds] }) }));
    expect(diags.map((x) => [x.checkId, x.severity])).toEqual([["GRAF101", "error"]]);
    expect(diags[0].message).toContain('variable "logs" chooses among loki datasources');
  });

  test("passes a DatasourceVariable whose plugin type only an ExternalDatasource has", () => {
    const ds = new DatasourceVariable({ name: "logs", pluginType: "loki" });
    const loki = new ExternalDatasource({ type: "loki", uid: "loki-prod" });
    expect(graf101.check(ctxOf({ prometheus, loki, d: new Dashboard({ title: "D", variables: [ds] }) }))).toEqual([]);
  });

  test("counts a DatasourceVariable in the no-datasource warning", () => {
    const ds = new DatasourceVariable({ name: "logs", pluginType: "loki" });
    const diags = graf101.check(ctxOf({ d: new Dashboard({ title: "D", variables: [ds] }) }));
    expect(diags.map((x) => [x.checkId, x.severity])).toEqual([["GRAF101", "warning"]]);
    expect(diags[0].message).toContain("datasource variables of type loki");
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

  test("checks a ref's type against an ExternalDatasource", () => {
    const traces = new ExternalDatasource({ type: "tempo", uid: "traces", name: "Traces" });
    const panel = new StatPanel({ datasource: { type: "prometheus", uid: "traces" }, targets: [up] });
    const diags = graf102.check(ctxOf({ traces, d: new Dashboard({ title: "D", panels: [panel] }) }));
    expect(diags[0].message).toContain('external datasource "Traces", which is tempo');
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

describe("GRAF104 and GRAF106 on external datasources", () => {
  test("flags an ExternalDatasource sharing a uid with a provisioned one", () => {
    const clash = new ExternalDatasource({ type: "prometheus", uid: "prometheus" });
    expect(graf104.check(ctxOf({ prometheus, clash })).map((d) => d.message)).toEqual([expect.stringContaining('2 datasources share the uid "prometheus"')]);
  });

  test("flags an ExternalDatasource uid Grafana rejects", () => {
    const bad = new ExternalDatasource({ type: "prometheus", uid: "has space" });
    expect(graf106.check(ctxOf({ bad })).map((d) => d.message)).toEqual([expect.stringContaining('ExternalDatasource "has space"')]);
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
  test("warns about an unknown dashboard key and query field, and fails a bad panel option", () => {
    const dash = dashboardJson(
      [panelJson({ options: { graphMode: "sparkline" }, datasource: { type: "prometheus", uid: "p" }, targets: [{ refId: "A", expr: "up", exprr: "typo" }] })],
      [],
      { owner: "team-a" },
    );
    const diags = graf107.check(ctxOfJson(dash)).map((d) => [d.severity, d.message]);
    expect(diags).toEqual([
      ["warning", expect.stringContaining('/: unknown key "owner" (not in the pinned schema)')],
      ["error", expect.stringContaining("/panels/0/options/graphMode: must be equal to one of the allowed values")],
      ["warning", expect.stringContaining('/panels/0/targets/0: unknown key "exprr" (not in the pinned schema)')],
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

describe("GRAF108: PromQL syntax", () => {
  const loki = new Datasource({ name: "Loki", type: "loki" });

  test("flags the unbalanced expression from the issue (#2955)", () => {
    const cluster = new QueryVariable({ name: "cluster", datasource: prometheus, query: "label_values(up, cluster)" });
    const panel = new StatPanel({ title: "Up", datasource: prometheus, targets: [new PromQuery({ expr: 'sum(x{cluster="$cluster"}' })] });
    const diags = graf108.check(ctxOf({ prometheus, d: new Dashboard({ title: "D", variables: [cluster], panels: [panel] }) }));
    expect(diags.map((d) => [d.checkId, d.severity])).toEqual([["GRAF108", "error"]]);
    expect(diags[0].message).toContain('panel "Up"');
    expect(diags[0].message).toContain("query A is not valid PromQL: the expression ends early");
  });

  test("flags a query variable and a panel query inheriting a Prometheus datasource variable", () => {
    const ds = new DatasourceVariable({ name: "ds", pluginType: "prometheus" });
    const job = new QueryVariable({ name: "job", datasource: prometheus, query: 'label_values(up{env="prod", job, instance)' });
    const panel = new TimeSeriesPanel({ title: "Rate", datasource: ds, targets: [new PromQuery({ expr: "rate(http_requests_total[5 m])" })] });
    const messages = graf108.check(ctxOf({ prometheus, d: new Dashboard({ title: "D", variables: [ds, job], panels: [panel] }) })).map((d) => d.message);
    expect(messages).toEqual([expect.stringContaining('panel "Rate" (id 1) query A is not valid PromQL'), expect.stringContaining('variable "job" query is not valid PromQL')]);
  });

  test("passes template variables and Grafana's macros where Prometheus would see a value", () => {
    const route = new QueryVariable({ name: "route", datasource: prometheus, query: 'label_values(http_requests_total{job="$job"}, route)' });
    const job = new QueryVariable({ name: "job", datasource: prometheus, query: "label_values(up, job)" });
    const exprs = [
      'sum by (le) (rate(http_request_duration_seconds_bucket{route=~"$route"}[$__rate_interval]))',
      'sum(increase(http_requests_total{job="${job}"}[$__range])) / $__range_s',
      'rate(http_requests_total{job=~"[[job]]"}[$__interval]) offset $__interval',
    ];
    const panel = new TimeSeriesPanel({ datasource: prometheus, targets: exprs.map((expr) => new PromQuery({ expr })) });
    expect(graf108.check(ctxOf({ prometheus, d: new Dashboard({ title: "D", variables: [job, route], panels: [panel] }) }))).toEqual([]);
  });

  test("leaves LogQL, TraceQL and queries of unknown destination alone", () => {
    const logs = new StatPanel({ datasource: loki, targets: [new LokiQuery({ expr: '{app="x"} |= "error" | json' })] });
    const traces = new TablePanel({ datasource: tempo, targets: [new TempoQuery({ query: "{ .status = error }" })] });
    const d = new Dashboard({ title: "D", panels: [logs, traces] });
    expect(graf108.check(ctxOf({ loki, tempo, d }))).toEqual([]);
    // No datasource anywhere: Grafana sends it to its default, whatever that is.
    const unknown = dashboardJson([panelJson({ targets: [{ refId: "A", expr: "sum(" }] })]);
    expect(graf108.check(ctxOfJson(unknown))).toEqual([]);
  });

  test("checks refs to a Prometheus the build does not declare, by the ref's own type", () => {
    const dash = dashboardJson([panelJson({ datasource: { type: "prometheus", uid: "elsewhere" }, targets: [{ refId: "A", expr: "sum(up" }] })]);
    expect(ids(graf108, ctxOfJson(dash))).toEqual([["GRAF108", "error"]]);
  });
});

describe("GRAF108 over real Grafana exports", () => {
  const exportsDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "test", "fixtures", "exports");
  const files = readdirSync(exportsDir)
    .filter((d) => d.startsWith("grafana-"))
    .flatMap((v) => readdirSync(join(exportsDir, v)).filter((f) => f.endsWith(".json") && !f.includes("v2-resource")).map((f) => `${v}/${f}`));

  test.each(files)("%s has no GRAF108 errors", (name) => {
    const text = readFileSync(join(exportsDir, name), "utf-8");
    // Non-vacuous: every export in the corpus sends PromQL to a Prometheus.
    expect(prometheusQueries(JSON.parse(text), knownDatasources([])).length).toBeGreaterThan(0);
    expect(graf108.check(makePostSynthCtxFromFiles("grafana", { [name]: text }, "{}"))).toEqual([]);
  });
});

describe("GRAF109: where provisioning puts dashboards (#2944)", () => {
  const pods = new Dashboard({ title: "Pods", uid: "pods", folder: "Platform/Kubernetes" });
  const team = new Dashboard({ title: "Team", uid: "team", folder: "Team" });
  const plain = new Dashboard({ title: "Plain", uid: "plain" });

  test("the default provider and one-level folders pass", () => {
    expect(graf109.check(ctxOf({ team, plain }))).toEqual([]);
  });

  test("a provider with a folder ignores each dashboard's own folder: a warning", () => {
    const provider = new DashboardProvider({ name: "team", folder: "Shared" });
    const diags = graf109.check(ctxOf({ team, plain, provider }));
    expect(diags.map((d) => [d.checkId, d.severity])).toEqual([["GRAF109", "warning"]]);
    expect(diags[0].message).toContain('"team" puts every dashboard in folder "Shared"');
    expect(diags[0].message).toContain('"Team" (Team)');
  });

  test("a provider with foldersFromFilesStructure: false and no folder puts them all in General", () => {
    const provider = new DashboardProvider({ name: "flat", foldersFromFilesStructure: false });
    const diags = graf109.check(ctxOf({ team, provider }));
    expect(diags.map((d) => d.severity)).toEqual(["warning"]);
    expect(diags[0].message).toContain("in General");
  });

  test("one provider mapping folders from directories is enough", () => {
    const pinned = new DashboardProvider({ name: "shared", folder: "Shared", path: "/elsewhere" });
    const mapped = new DashboardProvider({ name: "mapped" });
    expect(graf109.check(ctxOf({ team, pinned, mapped }))).toEqual([]);
  });

  test("two providers on the same path, or nested paths, in one org: an error", () => {
    const a = new DashboardProvider({ name: "a", path: "/var/lib/grafana/dashboards" });
    const b = new DashboardProvider({ name: "b", path: "/var/lib/grafana/dashboards/" });
    const c = new DashboardProvider({ name: "c", path: "/var/lib/grafana/dashboards/team" });
    const diags = graf109.check(ctxOf({ plain, a, b, c }));
    expect(diags.map((d) => [d.severity, d.entity])).toEqual([
      ["error", "b"],
      ["error", "c"],
      ["error", "c"],
    ]);
    expect(diags[0].message).toContain('"a" and "b" both load the dashboards under /var/lib/grafana/dashboards');
  });

  test("the same path in two orgs, and sibling paths, pass", () => {
    const a = new DashboardProvider({ name: "a", path: "/d" });
    const b = new DashboardProvider({ name: "b", path: "/d", orgId: 2 });
    const c = new DashboardProvider({ name: "c", path: "/dash" });
    expect(graf109.check(ctxOf({ plain, a, b, c }))).toEqual([]);
  });

  test("folder, folderUid and foldersFromFilesStructure together: Grafana refuses the provider", () => {
    const p = new DashboardProvider({ name: "p", folder: "X", folderUid: "x", foldersFromFilesStructure: true });
    expect(ids(graf109, ctxOf({ plain, p }))).toEqual([["GRAF109", "error"]]);
  });

  test("folder with foldersFromFilesStructure: the folder is not used", () => {
    const p = new DashboardProvider({ name: "p", folder: "X", foldersFromFilesStructure: true });
    const diags = graf109.check(ctxOf({ plain, p }));
    expect(diags.map((d) => d.severity)).toEqual(["warning"]);
    expect(diags[0].message).toContain('folder "X" is not used');
  });

  test("a nested folder: a warning naming what Grafana before 13.1 does", () => {
    const diags = graf109.check(ctxOf({ pods }));
    expect(diags.map((d) => [d.severity, d.entity])).toEqual([["warning", "pods"]]);
    expect(diags[0].message).toContain('top-level folder "Kubernetes"');
  });

  test("past Grafana's default nesting depth the warning says so; past its hard limit it is an error", () => {
    const deep = new Dashboard({ title: "Deep", uid: "deep", folder: "a/b/c/d/e" });
    const tooDeep = new Dashboard({ title: "Too deep", uid: "too-deep", folder: "a/b/c/d/e/f/g/h" });
    const diags = graf109.check(ctxOf({ deep, tooDeep }));
    expect(diags.map((d) => [d.severity, d.entity])).toEqual([
      ["warning", "deep"],
      ["error", "too-deep"],
    ]);
    expect(diags[0].message).toContain("max_nested_folder_depth of 4");
  });

  test("reads hand-written provisioning files too", () => {
    const files = {
      "dashboards/Team/d.json": JSON.stringify(dashboardJson([])),
      "provisioning/dashboards/a.yaml": "apiVersion: 1\nproviders:\n  - name: one\n    folder: Ops\n    options: { path: /d }\n",
    };
    expect(ids(graf109, makePostSynthCtxFromFiles("grafana", files, "{}"))).toEqual([["GRAF109", "warning"]]);
  });
});
