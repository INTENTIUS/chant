/**
 * The thin read (#2946) against an in-memory Grafana, and the shared
 * observation conformance suite over the same fake.
 */

import { describe, expect, it } from "vitest";
import { describeObservationConformance } from "@intentius/chant-test-utils";
import { normalizeObservation } from "@intentius/chant/observation";
import { describeResources, type GrafanaObserveOptions } from "./describe-resources";
import { fakeGrafana, liveDatasource, type FakeGrafanaState } from "./api/fake-grafana";
import { grafanaPlugin } from "./plugin";
import { Dashboard, DashboardProvider } from "./dashboard";
import { Datasource, ExternalDatasource } from "./datasource";
import { StatPanel, Row } from "./panels";
import { PromQuery } from "./query";
import { CustomVariable } from "./variables";

type Entities = GrafanaObserveOptions["entities"];

const CONFIG = { grafana: { profiles: { prod: { url: "http://grafana.test", token: { env: "GRAFANA_TEST_TOKEN" } } } } };
const ENV = { GRAFANA_TEST_TOKEN: "glsa_test" };

const prometheus = new Datasource({ name: "Prometheus", type: "prometheus", url: "http://prometheus:9090" });
const loki = new ExternalDatasource({ type: "loki", uid: "shared-loki" });
const up = new PromQuery({ expr: "up", datasource: prometheus });
const upPanel = new StatPanel({ title: "Up", targets: [up] });
const row = new Row({ title: "Health", panels: [upPanel] });
const env = new CustomVariable({ name: "env", values: ["prod", "staging"] });
const overview = new Dashboard({ title: "Overview", variables: [env], panels: [row] });
const legacy = new Dashboard({ title: "Legacy", uid: "legacy-board" });
const lonely = new StatPanel({ title: "On no dashboard" });
const provider = new DashboardProvider({ name: "ops" });

function entities(pairs: Record<string, { entityType: string; props: unknown }>): Entities {
  return new Map(Object.entries(pairs).map(([n, e]) => [n, { entityType: e.entityType, props: e.props as Record<string, unknown> }]));
}

const ALL = entities({ overview, legacy, prometheus, loki, upPanel, up, row, env, provider });

function state(overrides: Partial<FakeGrafanaState> = {}): FakeGrafanaState {
  return {
    api: "v1",
    dashboards: {
      overview: { spec: { title: "Overview", panels: [] }, annotations: { "grafana.app/managedBy": "classic-file-provisioning", "grafana.app/managerId": "ops" } },
      "legacy-board": { spec: { title: "Legacy", panels: [] }, labels: { "app.kubernetes.io/managed-by": "chant", "chant.intentius.io/stack": "shop", "chant.intentius.io/env": "prod" } },
    },
    datasources: { prometheus: liveDatasource({ name: "Prometheus", type: "prometheus", uid: "prometheus" }) },
    ...overrides,
  };
}

function run(s: FakeGrafanaState, opts: Partial<GrafanaObserveOptions> = {}, calls?: string[]) {
  return describeResources({
    environment: "prod",
    entityNames: [...ALL.keys()],
    entities: ALL,
    config: CONFIG,
    env: ENV,
    http: fakeGrafana(s, calls),
    ...opts,
  });
}

describe("describeResources", () => {
  it("reads each dashboard and datasource by the uid the build gives it, and says where it looked", async () => {
    const { resources, queried } = normalizeObservation(await run(state()));
    expect(resources.overview).toMatchObject({ type: "Grafana::Dashboard", physicalId: "overview", status: "PRESENT", ownership: "owned" });
    expect(resources.prometheus).toMatchObject({ physicalId: "prometheus", ownership: "unknown" });
    expect(queried.overview).toBe("/apis/dashboard.grafana.app/v1/namespaces/default/dashboards/overview");
    expect(queried.prometheus).toBe("/api/datasources/uid/prometheus");
  });

  it("uses v1beta1 on a 12.x server and /api/dashboards/uid on one without the dashboard API", async () => {
    expect(normalizeObservation(await run(state({ api: "v1beta1" }))).queried.overview).toContain("/v1beta1/");
    const legacyRead = normalizeObservation(await run(state({ api: "legacy" })));
    expect(legacyRead.queried.overview).toBe("/api/dashboards/uid/overview");
    expect(legacyRead.resources.overview.ownership).toBe("unknown");
  });

  it("a 404 is absent; an external datasource that is not there is absent too", async () => {
    const { resources, unobserved } = normalizeObservation(await run(state()));
    expect(resources.loki).toBeUndefined();
    expect(unobserved.loki).toBeUndefined();
  });

  it("a panel, row, query or variable takes its dashboard's verdict, with one read of the dashboard", async () => {
    const calls: string[] = [];
    const { resources } = normalizeObservation(await run(state(), {}, calls));
    for (const name of ["upPanel", "up", "row", "env"]) {
      expect(resources[name], name).toMatchObject({ physicalId: "overview", ownership: "owned", attributes: { dashboard: "overview" } });
    }
    expect(calls.filter((c) => c.endsWith("/dashboards/overview"))).toHaveLength(1);
  });

  it("a part of a dashboard that is absent is absent", async () => {
    const s = state();
    delete s.dashboards.overview;
    const { resources, unobserved } = normalizeObservation(await run(s));
    for (const name of ["overview", "upPanel", "up", "row", "env"]) {
      expect(resources[name], name).toBeUndefined();
      expect(unobserved[name], name).toBeUndefined();
    }
  });

  it("reads chant's marker, stack and env included, from the labels of a dashboard written through the API", async () => {
    const { resources } = normalizeObservation(await run(state()));
    expect(resources.legacy).toMatchObject({ ownership: "owned", marker: { stack: "shop", env: "prod" } });
  });

  it("a dashboard another provider loads is foreign", async () => {
    const s = state();
    s.dashboards.overview.annotations = { "grafana.app/managedBy": "classic-file-provisioning", "grafana.app/managerId": "other" };
    expect(normalizeObservation(await run(s)).resources.overview.ownership).toBe("foreign");
  });
});

describeObservationConformance({
  lexicon: "grafana",
  ownershipChannel: grafanaPlugin.ownershipChannel,
  scenarios: [
    {
      name: "a provisioned estate on Grafana 13",
      declared: [...ALL.keys()],
      run: () => run(state()),
      expectPresent: ["overview", "legacy", "prometheus", "upPanel", "up", "row", "env"],
      expectAbsent: ["loki"],
      expectUnobserved: ["provider"],
      expectMarker: { legacy: { stack: "shop", env: "prod" } },
      expectNoMarker: ["overview"],
    },
    {
      name: "owned: true keeps chant's dashboards and withholds what it cannot show is chant's",
      declared: [...ALL.keys()],
      owned: true,
      run: () => run(state(), { owned: true }),
      expectPresent: ["overview", "legacy"],
      expectUnobserved: ["prometheus", "provider"],
    },
    {
      name: "owned: true on Grafana 11, where no dashboard's ownership can be read",
      declared: ["overview", "legacy"],
      owned: true,
      run: () => run(state({ api: "legacy" }), { owned: true, entityNames: ["overview", "legacy"] }),
      expectUnobserved: ["overview", "legacy"],
    },
    {
      name: "a refused token",
      declared: [...ALL.keys()],
      run: () => run(state({ status: 401 })),
      expectUnobserved: [...ALL.keys()],
    },
    {
      name: "no Grafana bound to the environment",
      declared: ["overview"],
      run: () => describeResources({ environment: "staging", entityNames: ["overview"], entities: ALL, config: CONFIG, env: {} }),
      expectUnobserved: ["overview"],
    },
    {
      name: "a profile naming a token variable that is not set",
      declared: ["overview"],
      run: () => describeResources({ environment: "prod", entityNames: ["overview"], entities: ALL, config: CONFIG, env: {} }),
      expectUnobserved: ["overview"],
    },
    {
      name: "a dashboard stored as v2 that the server does not serve at v2",
      declared: ["overview"],
      run: () => {
        const s = state();
        s.dashboards.overview.storedVersion = "v2beta1";
        return run(s, { entityNames: ["overview"] });
      },
      expectUnobserved: ["overview"],
    },
    {
      name: "a panel on no dashboard",
      declared: ["lonely"],
      run: () => run(state(), { entityNames: ["lonely"], entities: new Map([...ALL, ["lonely", { entityType: lonely.entityType, props: lonely.props as unknown as Record<string, unknown> }]]) }),
      expectUnobserved: ["lonely"],
    },
  ],
});

/** A small v2 spec of the "Overview" dashboard: one stat panel in a tab. */
const OVERVIEW_V2 = {
  title: "Overview",
  annotations: [],
  cursorSync: "Off",
  links: [],
  preload: false,
  tags: [],
  variables: [],
  timeSettings: { from: "now-6h", to: "now", autoRefresh: "", autoRefreshIntervals: [], hideTimepicker: false, fiscalYearStartMonth: 0 },
  elements: {
    "panel-1": {
      kind: "Panel",
      spec: { id: 1, title: "Up", description: "", links: [], data: { kind: "QueryGroup", spec: { queries: [], transformations: [], queryOptions: {} } }, vizConfig: { kind: "VizConfig", group: "stat", version: "", spec: { options: {}, fieldConfig: { defaults: {}, overrides: [] } } } },
    },
  },
  layout: {
    kind: "TabsLayout",
    spec: { tabs: [{ kind: "TabsLayoutTab", spec: { title: "Health", layout: { kind: "GridLayout", spec: { items: [{ kind: "GridLayoutItem", spec: { x: 0, y: 0, width: 12, height: 8, element: { kind: "ElementReference", name: "panel-1" } } }] } } } }] },
  },
};

describe("a dashboard Grafana stores as v2 (#2947)", () => {
  for (const [api, version] of [["v1", "v2"], ["v1beta1", "v2beta1"]] as const) {
    it(`is read again at ${version} on a ${api} server, and says it was v2 and what the classic form cannot hold`, async () => {
      const s = state({ api });
      s.dashboards.overview = { ...s.dashboards.overview, storedVersion: version, v2: OVERVIEW_V2 };
      const calls: string[] = [];
      const obs = normalizeObservation(await run(s, { entityNames: ["overview"] }, calls));
      expect(obs.unobserved).toEqual({});
      // Ownership comes from the v2 resource's metadata, as from the classic one: the declared ops provider loads it.
      expect(obs.resources.overview).toMatchObject({ status: "PRESENT", ownership: "owned" });
      expect(obs.resources.overview.attributes).toMatchObject({ title: "Overview", schema: "v2", v2Lossy: [expect.stringMatching(/tabs "Health" become expanded rows/)] });
      expect(calls).toContain(`GET /apis/dashboard.grafana.app/${version}/namespaces/default/dashboards/overview`);
    });
  }

  it("a classic dashboard is read once, at the classic version, with no schema attribute", async () => {
    const calls: string[] = [];
    const obs = normalizeObservation(await run(state(), { entityNames: ["overview"] }, calls));
    expect(obs.resources.overview.attributes).not.toHaveProperty("schema");
    expect(calls.filter((c) => c.includes("/dashboards/overview"))).toEqual(["GET /apis/dashboard.grafana.app/v1/namespaces/default/dashboards/overview"]);
  });

  it("one the server does not serve at v2 is unsupported-kind, not the lossy classic read", async () => {
    const s = state();
    s.dashboards.overview.storedVersion = "v2";
    const obs = normalizeObservation(await run(s, { entityNames: ["overview"] }));
    expect(obs.unobserved.overview).toMatchObject({ reason: "unsupported-kind", detail: expect.stringMatching(/stored as a v2 dashboard .* lossy down-conversion/) });
  });

  it("a failed v2 read is read-failed", async () => {
    const s = state();
    s.dashboards.overview = { ...s.dashboards.overview, storedVersion: "v2", v2: OVERVIEW_V2 };
    const base = fakeGrafana(s);
    const http: typeof base = async (method, path, body) => (path.includes("/v2/") ? { status: 500, json: { message: "boom" } } : base(method, path, body));
    const obs = normalizeObservation(await describeResources({ environment: "prod", entityNames: ["overview"], entities: ALL, config: CONFIG, env: ENV, http }));
    expect(obs.unobserved.overview.reason).toBe("read-failed");
  });
});

describe("unobserved reasons", () => {
  it("names the reason each hole has", async () => {
    const refused = normalizeObservation(await run(state({ status: 401 })));
    expect(refused.unobserved.overview.reason).toBe("no-credentials");
    const unbound = normalizeObservation(await describeResources({ environment: "staging", entityNames: ["overview"], entities: ALL, config: CONFIG, env: {} }));
    expect(unbound.unobserved.overview).toMatchObject({ reason: "no-binding", detail: expect.stringContaining("GRAFANA_URL") });
    const noToken = normalizeObservation(await describeResources({ environment: "prod", entityNames: ["overview"], entities: ALL, config: CONFIG, env: {} }));
    expect(noToken.unobserved.overview).toMatchObject({ reason: "no-credentials", detail: expect.stringContaining("GRAFANA_TEST_TOKEN") });
    const failing = normalizeObservation(await run(state({ status: 500 })));
    expect(failing.unobserved.overview.reason).toBe("read-failed");
  });
});
