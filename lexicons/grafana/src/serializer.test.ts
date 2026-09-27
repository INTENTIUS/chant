/**
 * The grafana serializer, sectioned by the serializer checklist in the
 * lexicon-authoring docs (testing.mdx), plus format-specific cases.
 */
import { describe, expect, test } from "vitest";
import { load } from "js-yaml";
import type { Declarable } from "@intentius/chant/declarable";
import type { SerializerResult } from "@intentius/chant/serializer";
import { grafanaSerializer } from "./serializer";
import { Datasource } from "./datasource";
import { Dashboard, DashboardProvider } from "./dashboard";
import { StatPanel, TimeSeriesPanel } from "./panels";
import { PromQuery } from "./query";
import { DATASOURCES_FILE, DASHBOARD_PROVIDERS_FILE } from "./build";
import { DASHBOARD_SCHEMA_VERSION } from "./schema/dashboard.gen";
import { validateDashboardSchema } from "./schema-validate";

function run(entries: Record<string, Declarable>): SerializerResult {
  const out = grafanaSerializer.serialize(new Map(Object.entries(entries)));
  if (typeof out === "string") throw new Error(`expected files, got ${JSON.stringify(out)}`);
  return out;
}

const prometheus = new Datasource({ name: "Prometheus", type: "prometheus", url: "http://prometheus:9090" });
const up = new PromQuery({ expr: "sum(up)" });
const upPanel = new StatPanel({ title: "Up", datasource: prometheus, targets: [up] });

describe("grafana serializer", () => {
  // 1, 2
  test("name and rule prefix", () => {
    expect(grafanaSerializer.name).toBe("grafana");
    expect(grafanaSerializer.rulePrefix).toBe("GRAF");
  });

  // 3
  test("an empty build serializes to an empty string", () => {
    expect(grafanaSerializer.serialize(new Map())).toBe("");
  });

  // 4
  test("one dashboard: valid dashboard JSON and an index", () => {
    const out = run({ overview: new Dashboard({ title: "Overview", panels: [upPanel] }) });
    const json = JSON.parse(out.files!["dashboards/overview.json"]);
    expect(json.title).toBe("Overview");
    expect(json.panels).toHaveLength(1);
    expect(validateDashboardSchema(json)).toEqual([]);
    expect(JSON.parse(out.primary).dashboards).toEqual([{ uid: "overview", title: "Overview", file: "dashboards/overview.json" }]);
  });

  // 5
  test("the uid defaults to the export name as a uid", () => {
    const out = run({ checkoutServiceOverview: new Dashboard({ title: "Checkout" }) });
    expect(Object.keys(out.files!)).toContain("dashboards/checkout-service-overview.json");
  });

  // 6
  test("an explicit uid is kept", () => {
    const out = run({ overview: new Dashboard({ title: "Overview", uid: "svc-ovw" }) });
    expect(JSON.parse(out.files!["dashboards/svc-ovw.json"]).uid).toBe("svc-ovw");
  });

  // 7
  test("several dashboards and datasources: one file each, one datasources file", () => {
    const tempo = new Datasource({ name: "Tempo", type: "tempo", url: "http://tempo:3200" });
    const out = run({ prometheus, tempo, a: new Dashboard({ title: "A" }), b: new Dashboard({ title: "B", folder: "Team" }) });
    expect(Object.keys(out.files!).sort()).toEqual([
      "dashboards/Team/b.json",
      "dashboards/a.json",
      DASHBOARD_PROVIDERS_FILE,
      DATASOURCES_FILE,
    ]);
    const ds = load(out.files![DATASOURCES_FILE]) as { datasources: Array<{ name: string; uid: string }> };
    expect(ds.datasources.map((d) => [d.name, d.uid])).toEqual([
      ["Prometheus", "prometheus"],
      ["Tempo", "tempo"],
    ]);
  });

  // 8
  test("defaults Grafana needs are filled in", () => {
    const out = run({ prometheus, overview: new Dashboard({ title: "Overview", panels: [upPanel] }) });
    const json = JSON.parse(out.files!["dashboards/overview.json"]);
    expect(json.schemaVersion).toBe(DASHBOARD_SCHEMA_VERSION);
    expect(json.time).toEqual({ from: "now-6h", to: "now" });
    expect(json.templating).toEqual({ list: [] });
    expect(json.annotations).toEqual({ list: [] });
    expect(json.panels[0].fieldConfig).toEqual({ defaults: {}, overrides: [] });
    const ds = load(out.files![DATASOURCES_FILE]) as { datasources: Array<Record<string, unknown>> };
    expect(ds.datasources[0]).toMatchObject({ access: "proxy", editable: false });
    const providers = load(out.files![DASHBOARD_PROVIDERS_FILE]) as { providers: Array<Record<string, unknown>> };
    expect(providers.providers).toEqual([
      {
        name: "chant",
        orgId: 1,
        folder: "",
        type: "file",
        disableDeletion: false,
        allowUiUpdates: false,
        updateIntervalSeconds: 30,
        options: { path: "/var/lib/grafana/dashboards", foldersFromFilesStructure: true },
      },
    ]);
  });

  // 9
  test("explicit values override defaults", () => {
    const provider = new DashboardProvider({ name: "team", path: "/dashboards", folder: "Team", allowUiUpdates: true });
    const out = run({
      provider,
      overview: new Dashboard({ title: "Overview", time: { from: "now-1h", to: "now" }, editable: false }),
    });
    const json = JSON.parse(out.files!["dashboards/overview.json"]);
    expect(json.time).toEqual({ from: "now-1h", to: "now" });
    expect(json.editable).toBe(false);
    const providers = load(out.files![DASHBOARD_PROVIDERS_FILE]) as { providers: Array<Record<string, unknown>> };
    expect(providers.providers).toHaveLength(1);
    expect(providers.providers[0]).toMatchObject({
      name: "team",
      folder: "Team",
      allowUiUpdates: true,
      options: { path: "/dashboards", foldersFromFilesStructure: false },
    });
  });

  // 10
  test("exported panels and queries are inlined, not emitted on their own", () => {
    const out = run({ up, upPanel, prometheus });
    expect(Object.keys(out.files!)).toEqual([DATASOURCES_FILE]);
    expect(JSON.parse(out.primary).dashboards).toEqual([]);
  });

  // 11
  test("output is the same whatever order the props were written in", () => {
    const a = run({ d: new Dashboard({ title: "T", tags: ["x"], refresh: "1m" }) });
    const b = run({ d: new Dashboard({ refresh: "1m", tags: ["x"], title: "T" }) });
    expect(a.files).toEqual(b.files);
  });

  // 12
  test("datasource references are written as { type, uid }; the index names every file", () => {
    const loki = new Datasource({ name: "Loki", type: "loki", url: "http://loki:3100" });
    const settings = { tracesToLogsV2: { datasourceUid: loki } };
    const tempo = new Datasource({ name: "Tempo", type: "tempo", jsonData: settings });
    const out = run({ loki, tempo, prometheus, overview: new Dashboard({ title: "Overview", panels: [upPanel] }) });
    const json = JSON.parse(out.files!["dashboards/overview.json"]);
    expect(json.panels[0].datasource).toEqual({ type: "prometheus", uid: "prometheus" });
    expect(json.panels[0].targets[0]).toEqual({ datasource: { type: "prometheus", uid: "prometheus" }, refId: "A", expr: "sum(up)" });
    const ds = load(out.files![DATASOURCES_FILE]) as { datasources: Array<{ name: string; jsonData?: unknown }> };
    expect(ds.datasources.find((d) => d.name === "Tempo")?.jsonData).toEqual({ tracesToLogsV2: { datasourceUid: "loki" } });
    expect(JSON.parse(out.primary).files).toEqual(Object.keys(out.files!).sort());
  });

  test("round trip: the emitted text parses back to the declared values", () => {
    const panel = new TimeSeriesPanel({ title: "Rate", datasource: prometheus, targets: [up], interval: "30s" });
    const out = run({ d: new Dashboard({ title: "Round trip", description: "desc", tags: ["a", "b"], panels: [panel] }) });
    const json = JSON.parse(out.files!["dashboards/d.json"]);
    expect(json).toMatchObject({ title: "Round trip", description: "desc", tags: ["a", "b"] });
    expect(json.panels[0]).toMatchObject({ type: "timeseries", title: "Rate", interval: "30s" });
  });

  test("two dashboards with one uid keep both files, so GRAF104 can see them", () => {
    const out = run({ a: new Dashboard({ title: "A", uid: "same" }), b: new Dashboard({ title: "B", uid: "same" }) });
    expect(Object.keys(out.files!).filter((f) => f.startsWith("dashboards/")).sort()).toEqual(["dashboards/same-2.json", "dashboards/same.json"]);
  });

  test("entities of other lexicons are ignored", () => {
    const foreign = { lexicon: "k8s", entityType: "K8s::Core::ConfigMap", kind: "resource", props: {} } as unknown as Declarable;
    expect(grafanaSerializer.serialize(new Map([["cm", foreign]]))).toBe("");
  });
});
