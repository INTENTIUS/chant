/**
 * Live export (#2946) against an in-memory Grafana: the IR goes through the
 * importer's generator unchanged, and a dashboard exported from Grafana
 * generates the same source as the same JSON given to `chant import`.
 */

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { exportResources } from "./export-resources";
import { fakeGrafana, liveDatasource, type FakeGrafanaState } from "./api/fake-grafana";
import { GrafanaGenerator } from "./import/generator";
import { parseGrafana } from "./import/parser";
import { grafanaPlugin } from "./plugin";
import { datasourceProps } from "./import/live-export";

const CONFIG = { grafana: { profiles: { prod: { url: "http://grafana.test" } } } };

const board = {
  title: "Checkout",
  tags: ["shop"],
  graphTooltip: 1,
  schemaVersion: 41,
  panels: [
    {
      type: "timeseries",
      id: 1,
      title: "Requests",
      gridPos: { h: 8, w: 12, x: 0, y: 0 },
      datasource: { type: "prometheus", uid: "prom" },
      targets: [{ refId: "A", expr: "sum(rate(http_requests_total[5m]))", datasource: { type: "prometheus", uid: "prom" } }],
    },
  ],
};

function state(overrides: Partial<FakeGrafanaState> = {}): FakeGrafanaState {
  return {
    api: "v1",
    dashboards: {
      checkout: { spec: board, annotations: { "grafana.app/managedBy": "classic-file-provisioning", "grafana.app/managerId": "chant" } },
      "hand-made": { spec: { title: "Hand made", panels: [] } },
    },
    datasources: {
      prom: liveDatasource({ name: "Prom", type: "prometheus", uid: "prom", url: "http://prometheus:9090", isDefault: true, secure: ["basicAuthPassword"] }),
    },
    ...overrides,
  };
}

const exportFrom = (s: FakeGrafanaState, opts: Partial<Parameters<typeof exportResources>[0]> = {}) =>
  exportResources({ environment: "prod", config: CONFIG, env: {}, http: fakeGrafana(s), ...opts });

describe("exportResources", () => {
  it("is wired on the plugin", () => {
    expect(typeof grafanaPlugin.exportResources).toBe("function");
  });

  it("feeds the importer's generator unchanged, and generates what chant import writes for the same JSON", async () => {
    const ir = await exportFrom(state(), { selector: { type: "Grafana::Dashboard", name: "checkout" } });
    const exported = new GrafanaGenerator().generate(ir);
    const imported = new GrafanaGenerator().generate(parseGrafana(JSON.stringify({ ...board, uid: "checkout" })));
    expect(exported).toEqual(imported);
    expect(exported.map((f) => f.path)).toEqual(expect.arrayContaining([expect.stringMatching(/^checkout\/dashboard\.ts$/)]));
  });

  it("exports every dashboard and datasource, secrets as key names only", async () => {
    const ir = await exportFrom(state());
    expect(ir.resources.map((r) => `${r.type}:${r.logicalId}`).sort()).toEqual(["Grafana::Dashboard:checkout", "Grafana::Dashboard:handMade", "Grafana::Provisioning:datasources"]);
    const files = new GrafanaGenerator().generate(ir);
    const ds = files.find((f) => f.path === "datasources.ts")!.content;
    expect(ds).toContain('basicAuthPassword: "[REDACTED]"');
    expect(ir.warnings?.join("\n")).toMatch(/\[REDACTED\]/);
  });

  it("a dashboard refers to a datasource exported beside it by uid, rather than declaring it again", async () => {
    const files = new GrafanaGenerator().generate(await exportFrom(state()));
    const dashboardDatasources = files.find((f) => f.path === "checkout/dashboard.ts")!.content;
    expect(dashboardDatasources).not.toContain("ExternalDatasource");
    expect(dashboardDatasources).toMatch(/const prom: DatasourceRef<"prometheus"> = \{ type: "prometheus", uid: "prom" \}/);
    expect(files.find((f) => f.path === "datasources.ts")!.content).toContain("new Datasource(");
  });

  it("owned keeps only chant's dashboards and no datasources", async () => {
    const ir = await exportFrom(state(), { owned: true });
    expect(ir.resources.map((r) => r.logicalId)).toEqual(["checkout"]);
    expect(ir.warnings?.join("\n")).toMatch(/datasources are not exported with --owned/);
  });

  it("reads the legacy API on a server without dashboard.grafana.app", async () => {
    const ir = await exportFrom(state({ api: "legacy" }), { selector: { name: "checkout" } });
    expect(ir.resources.map((r) => r.logicalId)).toEqual(["checkout"]);
  });

  it("leaves out a v2-stored dashboard the server does not serve at v2, and says so", async () => {
    const s = state();
    s.dashboards.checkout.storedVersion = "v2beta1";
    const ir = await exportFrom(s, { selector: { type: "Grafana::Dashboard" } });
    expect(ir.resources.map((r) => r.logicalId)).toEqual(["handMade"]);
    expect(ir.warnings?.join("\n")).toMatch(/checkout is not exported: it is stored as a v2beta1 dashboard .* lossy down-conversion/);
  });

  it("exports a v2-stored dashboard through its v2 read, as chant import of the same v2 JSON does (#2947)", async () => {
    const fixture = JSON.parse(readFileSync(join(import.meta.dirname, "..", "test", "fixtures", "exports", "grafana-13.2.2", "tabs.v2-resource.json"), "utf-8")) as { spec: Record<string, unknown> };
    const s = state();
    s.dashboards.checkout = { ...s.dashboards.checkout, storedVersion: "v2", v2: fixture.spec };
    const ir = await exportFrom(s, { selector: { type: "Grafana::Dashboard", name: "checkout" } });
    expect(ir.resources.map((r) => r.logicalId)).toEqual(["checkoutTabs"]);
    expect(ir.warnings).toContainEqual(expect.stringMatching(/^dashboard checkout is stored as v2 and exported in the classic model: layout: the dashboard's tabs "Overview" and "Details" become expanded rows/));
    const exported = new GrafanaGenerator().generate(ir);
    const imported = new GrafanaGenerator().generate(parseGrafana(JSON.stringify({ ...fixture, metadata: { name: "checkout" } })));
    expect(exported).toEqual(imported);
  });

  it("fails loudly when there is no Grafana to read", async () => {
    await expect(exportResources({ environment: "staging", config: CONFIG, env: {} })).rejects.toThrow(/GRAFANA_URL/);
  });
});

describe("datasourceProps", () => {
  const live = liveDatasource({ name: "Prom", type: "prometheus", uid: "prom", url: "http://p:9090", secure: ["password"] });

  it("keeps what somebody set, and names secrets without their values", () => {
    expect(datasourceProps(live)).toEqual({ name: "Prom", type: "prometheus", uid: "prom", url: "http://p:9090", secureJsonData: { password: "[REDACTED]" } });
  });

  it("keeps the API's defaults under verbatim, and editable from readOnly", () => {
    expect(datasourceProps({ ...live, readOnly: false }, { keepDefaults: true })).toMatchObject({ access: "proxy", isDefault: false, editable: true });
  });
});
