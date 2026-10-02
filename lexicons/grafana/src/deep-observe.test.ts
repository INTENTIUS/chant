/**
 * Deep observation (#2946) against an in-memory Grafana: the built examples,
 * stored the way Grafana stores them, read back and diffed against their
 * declarations through core's own deep diff.
 *
 * The first block is the noise check: an untouched dashboard must report no
 * drift and nothing unclaimed, on the 13.x, 12.x and 11.x read paths. The
 * rest edit the stored copy the way a UI save would and pin what the diff
 * reports.
 */

import { beforeAll, describe, expect, it } from "vitest";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { build } from "@intentius/chant/build";
import { isObservableDeclarable } from "@intentius/chant/declarable";
import type { SerializerResult } from "@intentius/chant/serializer";
import { otelSerializer } from "@intentius/chant-lexicon-otel/serializer";
import { prometheusSerializer } from "@intentius/chant-lexicon-prometheus/serializer";
import { grafanaSerializer } from "./serializer";
import { observeResourcesDeepGrafana } from "./deep-observe";
import { grafanaDeepNormalizationHooks } from "./deep-observe-hooks";
import { fakeGrafana, liveDatasource, storedDashboard, type FakeGrafanaState } from "./api/fake-grafana";
import { load } from "js-yaml";
import { DATASOURCES_FILE, buildGrafana, type GrafanaIndex } from "./build";
import { Dashboard } from "./dashboard";
import { Folder } from "./folder";

const { diffDeepObservation } = await import("@intentius/chant/lifecycle/deep-observe");
const { normalizeDeepObservation } = await import("@intentius/chant/deep-observation");

type Json = Record<string, unknown>;
type Entities = Map<string, { entityType: string; props: Record<string, unknown> }>;

const EXAMPLES = join(import.meta.dirname, "..", "examples");
const CONFIG = { grafana: { profiles: { prod: { url: "http://grafana.test" } } } };

interface Built {
  entities: Entities;
  index: GrafanaIndex;
  files: Record<string, string>;
}

async function buildExample(name: string): Promise<Built> {
  const result = await build(join(EXAMPLES, name, "src"), [otelSerializer, prometheusSerializer, grafanaSerializer]);
  expect(result.errors).toEqual([]);
  const out = result.outputs.get("grafana") as SerializerResult;
  const entities: Entities = new Map();
  for (const [n, e] of result.entities) {
    if (e.lexicon === "grafana" && isObservableDeclarable(e)) entities.set(n, { entityType: e.entityType, props: e.props as Record<string, unknown> });
  }
  return { entities, index: JSON.parse(out.primary) as GrafanaIndex, files: out.files ?? {} };
}

/** Grafana after provisioning the build: every dashboard stored, in its folder, managed by the `chant` provider; every datasource. */
function provisioned(b: Built, api: FakeGrafanaState["api"]): FakeGrafanaState {
  const folders: Record<string, string> = {};
  const dashboards: FakeGrafanaState["dashboards"] = {};
  for (const d of b.index.dashboards) {
    const folderUid = d.folder ? `f-${d.folder.toLowerCase()}` : undefined;
    if (folderUid) folders[folderUid] = d.folder!;
    dashboards[d.uid] = {
      spec: storedDashboard(JSON.parse(b.files[d.file]) as Json),
      annotations: { "grafana.app/managedBy": "classic-file-provisioning", "grafana.app/managerId": "chant" },
      ...(folderUid ? { folderUid } : {}),
    };
  }
  // Datasources as Grafana serves them after reading the provisioning file.
  const datasources: Record<string, Json> = {};
  const file = b.files[DATASOURCES_FILE];
  const entries = file ? ((load(file) as { datasources: Json[] }).datasources ?? []) : [];
  for (const ds of entries) {
    datasources[String(ds.uid)] = {
      ...liveDatasource({ name: String(ds.name), type: String(ds.type), uid: String(ds.uid), url: ds.url as string | undefined, isDefault: ds.isDefault as boolean | undefined, jsonData: ds.jsonData as Json | undefined, secure: Object.keys((ds.secureJsonData as Json | undefined) ?? {}) }),
      readOnly: ds.editable !== true,
    };
  }
  return { api, dashboards, datasources, folders };
}

async function diff(b: Built, state: FakeGrafanaState) {
  const live = await observeResourcesDeepGrafana({
    environment: "prod",
    entityNames: [...b.entities.keys()],
    entities: b.entities,
    config: CONFIG,
    http: fakeGrafana(state),
  });
  return { live, result: diffDeepObservation(b.entities, normalizeDeepObservation(live), grafanaDeepNormalizationHooks) };
}

function driftPaths(result: Awaited<ReturnType<typeof diff>>["result"]): string[] {
  return result.drifted.flatMap((e) => e.changes.map((c) => `${e.name}:${c.kind}:${c.path}`));
}

function unclaimedPaths(result: Awaited<ReturnType<typeof diff>>["result"]): string[] {
  return result.unclaimed.flatMap((e) => e.fields.map((f) => `${e.name}:${f.path}`));
}

let gettingStarted: Built;
let declarations: Built;

beforeAll(async () => {
  gettingStarted = await buildExample("getting-started");
  declarations = await buildExample("dashboards-from-declarations");
}, 60_000);

describe("an untouched provisioned dashboard reads back with no drift and nothing unclaimed", () => {
  for (const api of ["v1", "v1beta1", "legacy"] as const) {
    it(`getting-started, ${api}`, async () => {
      const { live, result } = await diff(gettingStarted, provisioned(gettingStarted, api));
      expect(normalizeDeepObservation(live).unobserved).toEqual({});
      expect(driftPaths(result)).toEqual([]);
      expect(unclaimedPaths(result)).toEqual([]);
      expect(result.unchanged).toEqual(expect.arrayContaining(["serviceOverview", "prometheus", "tempo", "loki"]));
    });

    it(`dashboards-from-declarations (RED, SLO and agent composites), ${api}`, async () => {
      const { result } = await diff(declarations, provisioned(declarations, api));
      expect(driftPaths(result)).toEqual([]);
      expect(unclaimedPaths(result)).toEqual([]);
    });
  }
});

describe("an edited dashboard is drift, at the path the author wrote", () => {
  function edited(b: Built, uid: string, edit: (spec: Json) => void): FakeGrafanaState {
    const state = provisioned(b, "v1");
    edit(state.dashboards[uid].spec);
    return state;
  }

  const panels = (spec: Json) => spec.panels as Json[];

  it("a query changed in the UI", async () => {
    const state = edited(gettingStarted, "service-overview", (spec) => {
      const p = panels(spec).find((x) => x.title === "Requests per second by operation")!;
      (p.targets as Json[])[0].expr = "sum(rate(http_requests_total[1m]))";
    });
    const { result } = await diff(gettingStarted, state);
    const changes = result.drifted.find((e) => e.name === "serviceOverview")!.changes;
    expect(changes).toEqual([
      expect.objectContaining({ kind: "changed", path: expect.stringMatching(/^panels\[\d+\]\.panels\[\d+\]\.targets\[0\]\.expr$/), live: "sum(rate(http_requests_total[1m]))" }),
    ]);
  });

  it("a panel retitled, and the dashboard's time range and refresh changed", async () => {
    const state = edited(gettingStarted, "service-overview", (spec) => {
      panels(spec).find((x) => x.title === "Error ratio")!.title = "Errors";
      spec.time = { from: "now-24h", to: "now" };
      spec.refresh = "5m";
    });
    const { result } = await diff(gettingStarted, state);
    const paths = driftPaths(result);
    expect(paths).toEqual(expect.arrayContaining([expect.stringMatching(/^serviceOverview:changed:panels\[\d+\]\.panels\[\d+\]\.title$/)]));
    const top = result.drifted.find((e) => e.name === "serviceOverview")!.changes.filter((c) => !c.path.startsWith("panels"));
    expect(top.map((c) => `${c.path}=${String(c.live)}`).sort()).toEqual(["refresh=5m", "time.from=now-24h"]);
  });

  it("a panel deleted in the UI is reported absent", async () => {
    const state = edited(gettingStarted, "service-overview", (spec) => {
      spec.panels = panels(spec).filter((x) => x.title !== "About");
    });
    const { result } = await diff(gettingStarted, state);
    // Positional: the first panel is now the row that followed it, so its declared title moved.
    expect(driftPaths(result)).toEqual(expect.arrayContaining(["serviceOverview:changed:panels[0].title"]));
  });

  it("a panel added in the UI is reported as unclaimed, with its values", async () => {
    const state = edited(gettingStarted, "service-overview", (spec) => {
      panels(spec).push({ type: "stat", title: "Added in the UI", id: 99, gridPos: { h: 4, w: 6, x: 0, y: 100 }, targets: [{ refId: "A", expr: "up", datasource: { type: "prometheus", uid: "prometheus" } }] });
    });
    const { result } = await diff(gettingStarted, state);
    expect(unclaimedPaths(result)).toEqual(expect.arrayContaining([expect.stringMatching(/^serviceOverview:panels\[\d+\]\.title$/)]));
  });

  it("a dashboard moved to another folder", async () => {
    const state = provisioned(gettingStarted, "v1");
    state.folders!["f-other"] = "Other";
    state.dashboards["service-overview"].folderUid = "f-other";
    const { result } = await diff(gettingStarted, state);
    expect(driftPaths(result)).toEqual(["serviceOverview:changed:folder"]);
  });

  it("the same edit reads the same through the legacy API (Grafana 11)", async () => {
    const state = provisioned(gettingStarted, "legacy");
    (panels(state.dashboards["service-overview"].spec).find((x) => x.title === "Requests per second by operation")!.targets as Json[])[0].expr = "up";
    const { result } = await diff(gettingStarted, state);
    expect(driftPaths(result)).toEqual([expect.stringMatching(/^serviceOverview:changed:panels\[\d+\]\.panels\[\d+\]\.targets\[0\]\.expr$/)]);
  });
});

describe("datasources", () => {
  it("a changed URL is drift; secrets compare by key and never by value", async () => {
    const state = provisioned(gettingStarted, "v1");
    state.datasources!.prometheus = liveDatasource({ name: "Prometheus", type: "prometheus", uid: "prometheus", url: "http://elsewhere:9090", isDefault: true, secure: ["basicAuthPassword"] });
    const { live, result } = await diff(gettingStarted, state);
    const props = normalizeDeepObservation(live).resources.prometheus.properties;
    expect(props.secureJsonData).toEqual({ basicAuthPassword: "[REDACTED]" });
    const changes = result.drifted.find((e) => e.name === "prometheus")?.changes ?? [];
    expect(changes.map((c) => `${c.kind}:${c.path}`)).toContain("changed:url");
    expect(JSON.stringify(result)).not.toMatch(/elsewhere.*password|hunter2/);
  });
});

describe("a dashboard Grafana stores as v2 (#2947)", () => {
  it("is read at v2 and diffed through its classic form: the tabs a UI save made are drift", async () => {
    const state = provisioned(gettingStarted, "v1");
    // Saved from the new editor as the tabs dashboard of the import fixtures, under this dashboard's uid.
    const v2 = (JSON.parse(readFileSync(join(import.meta.dirname, "..", "test", "fixtures", "exports", "grafana-13.2.2", "tabs.v2-resource.json"), "utf-8")) as Json).spec as Json;
    state.dashboards["service-overview"] = { ...state.dashboards["service-overview"], storedVersion: "v2", v2 };
    const { live, result } = await diff(gettingStarted, state);
    const { resources, unobserved } = normalizeDeepObservation(live);
    expect(unobserved.serviceOverview).toBeUndefined();
    expect(resources.serviceOverview.properties.title).toBe("Checkout (tabs)");
    const paths = driftPaths(result).filter((p) => p.startsWith("serviceOverview:"));
    expect(paths).toContain("serviceOverview:changed:title");
    // The tabs are rows in the live tree.
    const rows = (resources.serviceOverview.properties.panels as Json[]).map((p) => p.title);
    expect(rows).toEqual(expect.arrayContaining(["Overview", "Details"]));
  });
});

describe("what cannot be read is not observed, never a clean tree", () => {
  it("a dashboard stored as v2 that the server does not serve at v2 is unsupported-kind, not its lossy classic read", async () => {
    const state = provisioned(gettingStarted, "v1");
    state.dashboards["service-overview"].storedVersion = "v2beta1";
    const { live } = await diff(gettingStarted, state);
    const { resources, unobserved } = normalizeDeepObservation(live);
    expect(resources.serviceOverview).toBeUndefined();
    expect(unobserved.serviceOverview).toMatchObject({ reason: "unsupported-kind", detail: expect.stringMatching(/stored as a v2beta1 dashboard .* lossy down-conversion/) });
  });

  it("a refused token is no-credentials for every entity", async () => {
    const { live } = await diff(gettingStarted, { ...provisioned(gettingStarted, "v1"), status: 401 });
    const { resources, unobserved } = normalizeDeepObservation(live);
    expect(resources).toEqual({});
    expect(Object.keys(unobserved).sort()).toEqual([...gettingStarted.entities.keys()].sort());
    expect(new Set(Object.values(unobserved).map((u) => u.reason))).toEqual(new Set(["no-credentials"]));
  });

  it("no binding is no-binding for every entity", async () => {
    const live = await observeResourcesDeepGrafana({ environment: "staging", entityNames: [], entities: gettingStarted.entities, config: CONFIG, env: {} });
    const { unobserved } = normalizeDeepObservation(live);
    expect(new Set(Object.values(unobserved).map((u) => u.reason))).toEqual(new Set(["no-binding"]));
  });

  it("a server error is read-failed for that entity alone", async () => {
    const state = provisioned(gettingStarted, "v1");
    const base = fakeGrafana(state);
    const http: typeof base = async (method, path, body) => (path.includes("/datasources/uid/tempo") ? { status: 500, json: { message: "boom" } } : base(method, path, body));
    const live = await observeResourcesDeepGrafana({ environment: "prod", entityNames: [], entities: gettingStarted.entities, config: CONFIG, http });
    const { resources, unobserved } = normalizeDeepObservation(live);
    expect(unobserved.tempo).toMatchObject({ reason: "read-failed", detail: expect.stringContaining("500") });
    expect(resources.serviceOverview).toBeDefined();
  });

  it("owned: true withholds a dashboard another provider manages, and every datasource", async () => {
    const state = provisioned(gettingStarted, "v1");
    state.dashboards["service-overview"].annotations = { "grafana.app/managedBy": "classic-file-provisioning", "grafana.app/managerId": "someone-else" };
    const live = await observeResourcesDeepGrafana({ environment: "prod", entityNames: [], entities: gettingStarted.entities, config: CONFIG, http: fakeGrafana(state), owned: true });
    const { resources, unobserved } = normalizeDeepObservation(live);
    expect(resources).toEqual({});
    expect(unobserved.serviceOverview.reason).toBe("filtered");
    expect(unobserved.prometheus.reason).toBe("filtered");
  });
});

describe("folders (#2953)", () => {
  const platform = new Folder({ title: "Platform", uid: "plat" });
  const k8s = new Folder({ title: "Kubernetes", parent: platform });
  const pods = new Dashboard({ title: "Pods", uid: "pods", folder: k8s });

  function nested(): { built: Built; state: FakeGrafanaState } {
    const out = buildGrafana(new Map<string, never>([["pods", pods as never], ["k8s", k8s as never]]));
    const entities: Entities = new Map([
      ["pods", { entityType: pods.entityType, props: pods.props as Record<string, unknown> }],
      ["k8s", { entityType: k8s.entityType, props: k8s.props as unknown as Record<string, unknown> }],
    ]);
    const state: FakeGrafanaState = {
      api: "v1",
      dashboards: {
        pods: {
          spec: storedDashboard(JSON.parse(out.files["dashboards/Platform/Kubernetes/pods.json"]) as Json),
          annotations: { "grafana.app/managedBy": "classic-file-provisioning", "grafana.app/managerId": "chant" },
          folderUid: "platform-kubernetes",
        },
      },
      folders: { plat: "Platform", "platform-kubernetes": "Kubernetes", other: "Other" },
      folderParents: { "platform-kubernetes": "plat" },
    };
    return { built: { entities, index: out.index, files: out.files }, state };
  }

  it("a dashboard in a nested Folder reads back as its path, and the Folder by its uid, with no drift", async () => {
    const { built, state } = nested();
    const { live, result } = await diff(built, state);
    expect(normalizeDeepObservation(live).unobserved).toEqual({});
    expect(driftPaths(result)).toEqual([]);
    expect(unclaimedPaths(result)).toEqual([]);
  });

  it("a nested folder moved or renamed shows on the dashboard's path and the Folder's title", async () => {
    const { built, state } = nested();
    state.folderParents!["platform-kubernetes"] = "other";
    expect(driftPaths((await diff(built, state)).result)).toEqual(["pods:changed:folder"]);
    state.folderParents!["platform-kubernetes"] = "plat";
    state.folders!["platform-kubernetes"] = "K8s";
    expect(driftPaths((await diff(built, state)).result).sort()).toEqual(["k8s:changed:title", "pods:changed:folder"]);
  });
});
