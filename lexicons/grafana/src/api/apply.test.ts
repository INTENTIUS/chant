import { describe, expect, test } from "vitest";
import { GrafanaClient } from "./client";
import { applyGrafana, carriesMarker, planFromDashboards, planRefs, type GrafanaApplyPlan } from "./apply";
import { converged } from "./converge";
import { childrenFirst, folderUidFor, foldersForDashboards, type LiveFolder } from "./folders";
import { libraryPanelsOf, withoutExportKeys } from "./library-panels";
import { emptyGrafana, writableGrafana, type WritableGrafanaState } from "./fake-grafana-writes";

type Json = Record<string, unknown>;

const TARGET = { url: "http://grafana.test", source: "grafana.profiles.test" };
const MARKER = { stack: "shop", env: "prod" };
const OURS = { "app.kubernetes.io/managed-by": "chant", "chant.intentius.io/stack": "shop", "chant.intentius.io/env": "prod" };

function dashboard(uid: string, extra: Json = {}): Json {
  return { uid, title: uid, schemaVersion: 41, time: { from: "now-6h", to: "now" }, panels: [{ id: 1, type: "stat", title: "a", gridPos: { x: 0, y: 0, w: 6, h: 4 }, options: {}, datasource: null }], ...extra };
}

const LIB = { name: "Shared burn", uid: "burn", kind: 1, model: { type: "stat", title: "Burn", targets: [] } };

function client(state: WritableGrafanaState, calls: string[] = []): GrafanaClient {
  return new GrafanaClient(writableGrafana(state, calls), TARGET);
}

const writes = (calls: string[]) => calls.filter((c) => !c.startsWith("GET "));

describe("planFromDashboards", () => {
  test("one folder per title, library panels from __elements, export-only keys dropped", () => {
    const plan = planFromDashboards([
      { json: dashboard("a", { __inputs: [], __requires: [], __elements: { burn: LIB } }), folder: "Team A" },
      { json: dashboard("b", { __elements: { burn: LIB } }), folder: "Team A" },
      { json: dashboard("c") },
    ]);
    expect(plan.folders).toEqual([{ uid: "team-a", title: "Team A" }]);
    expect(plan.libraryPanels).toEqual([{ uid: "burn", name: "Shared burn", model: LIB.model, folderUid: "team-a" }]);
    expect(plan.dashboards.map((d) => [d.uid, d.folderUid])).toEqual([["a", "team-a"], ["b", "team-a"], ["c", undefined]]);
    expect(Object.keys(plan.dashboards[0].json)).not.toEqual(expect.arrayContaining(["__elements"]));
    expect(planRefs(plan).map((r) => `${r.kind}/${r.name}`)).toEqual(["Folder/team-a", "LibraryPanel/burn", "Dashboard/a", "Dashboard/b", "Dashboard/c"]);
  });

  test("a library variable in __elements is reported unsupported, not dropped", () => {
    const plan = planFromDashboards([{ json: dashboard("a", { __elements: { v: { uid: "v", name: "v", kind: 2, model: {} } } }) }]);
    expect(plan.unsupported).toEqual([expect.objectContaining({ kind: "LibraryElement", name: "v" })]);
    expect(planRefs(plan).map((r) => `${r.kind}/${r.name}`)).toContain("LibraryElement/v");
  });

  test("refuses a plan no apply could satisfy", () => {
    expect(() => planFromDashboards([{ json: { title: "x" } }])).toThrow(/has no uid/);
    expect(() => planFromDashboards([{ json: dashboard("a") }, { json: dashboard("a") }])).toThrow(/two dashboards have the uid "a"/);
    const other = { ...LIB, model: { ...LIB.model, title: "Other" } };
    expect(() => planFromDashboards([{ json: dashboard("a", { __elements: { burn: LIB } }) }, { json: dashboard("b", { __elements: { burn: other } }) }])).toThrow(/different content/);
  });
});

describe("folders", () => {
  test("the uid is the slug of the title, and two titles that share one are refused", () => {
    expect(folderUidFor("Team A / Payments")).toBe("team-a-payments");
    expect(() => foldersForDashboards([{ folder: "Team A" }, { folder: "team-a" }])).toThrow(/would both get the uid "team-a"/);
  });

  test("children come before their parents for deletion", () => {
    const f = (uid: string, parentUid?: string): LiveFolder => ({ uid, title: uid, ...(parentUid ? { parentUid } : {}), labels: {}, via: "apis", address: uid });
    expect(childrenFirst([f("root"), f("leaf", "mid"), f("mid", "root")]).map((x) => x.uid)).toEqual(["leaf", "mid", "root"]);
  });
});

describe("library panels", () => {
  test("uid falls back to the __elements key; export-only keys are dropped", () => {
    const { panels } = libraryPanelsOf({ __elements: { k: { name: "n", kind: 1, model: { type: "stat" } } } });
    expect(panels).toEqual([{ uid: "k", name: "n", model: { type: "stat" } }]);
    expect(withoutExportKeys({ uid: "a", __elements: {}, __inputs: [], __requires: [] })).toEqual({ uid: "a" });
  });
});

describe("converged", () => {
  test("what Grafana adds on top is ignored; what the build sends must be there", () => {
    const want = dashboard("a", { annotations: { list: [{ name: "Deploys" }] } });
    const live = {
      ...want,
      uid: undefined,
      id: 9,
      version: 4,
      schemaVersion: 42,
      fiscalYearStartMonth: 0,
      annotations: { list: [{ builtIn: 1, name: "Annotations & Alerts" }, { name: "Deploys" }] },
      panels: [{ id: 1, type: "stat", title: "a", gridPos: { x: 0, y: 0, w: 6, h: 4 } }],
    };
    expect(converged(want, live, { dashboard: true })).toBe(true);
    expect(converged(want, { ...live, title: "edited" }, { dashboard: true })).toBe(false);
    expect(converged(want, { ...live, panels: [...live.panels, { id: 2, type: "text" }] }, { dashboard: true })).toBe(false);
    expect(converged({ tags: [] }, {})).toBe(true);
    expect(converged({ tags: ["a"] }, {})).toBe(false);
  });
});

describe("carriesMarker", () => {
  test("this stack and this env only", () => {
    expect(carriesMarker(OURS, MARKER)).toBe(true);
    expect(carriesMarker({ ...OURS, "chant.intentius.io/stack": "other" }, MARKER)).toBe(false);
    expect(carriesMarker({ ...OURS, "chant.intentius.io/env": "staging" }, MARKER)).toBe(false);
    const { "chant.intentius.io/env": _env, ...envless } = OURS;
    expect(carriesMarker(envless, MARKER)).toBe(false);
    expect(carriesMarker(envless, { stack: "shop" })).toBe(true);
    expect(carriesMarker({}, MARKER)).toBe(false);
  });
});

function planWithEverything(): GrafanaApplyPlan {
  return planFromDashboards([
    { json: dashboard("api", { __elements: { burn: LIB }, panels: [{ id: 1, gridPos: { x: 0, y: 0, w: 6, h: 4 }, libraryPanel: { uid: "burn", name: "Shared burn" } }] }), folder: "Team A" },
    { json: dashboard("home") },
  ]);
}

describe.each(["v1", "v1beta1"] as const)("applyGrafana over /apis (%s)", (api) => {
  test("creates the folder, then the library panel, then the dashboards, stamped with the marker", async () => {
    const state = emptyGrafana(api);
    const calls: string[] = [];
    const out = await applyGrafana(client(state, calls), planWithEverything(), { marker: MARKER });
    expect(out.api).toBe(`apis/${api}`);
    expect(out.applied.map((a) => `${a.action} ${a.kind}/${a.name}`)).toEqual(["created Folder/team-a", "created LibraryPanel/burn", "created Dashboard/api", "created Dashboard/home"]);
    expect(writes(calls).map((c) => c.split(" ")[0] + " " + c.split("/").slice(-1)[0])).toEqual(["POST folders", "POST library-elements", "POST dashboards", "POST dashboards"]);
    expect(state.dashboards.api.labels).toEqual(OURS);
    expect(state.dashboards.api.annotations).toEqual({ "grafana.app/folder": "team-a" });
    expect(state.dashboards.api.spec.__elements).toBeUndefined();
    expect(state.folders["team-a"]).toMatchObject({ spec: { title: "Team A" }, labels: OURS });
    expect(state.libraryElements.burn).toMatchObject({ name: "Shared burn", folderUid: "team-a" });
  });

  test("a second apply of the same plan is unchanged and writes nothing", async () => {
    const state = emptyGrafana(api);
    await applyGrafana(client(state), planWithEverything(), { marker: MARKER });
    const calls: string[] = [];
    const out = await applyGrafana(client(state, calls), planWithEverything(), { marker: MARKER });
    expect(out.applied.every((a) => a.action === "unchanged")).toBe(true);
    expect(writes(calls)).toEqual([]);
  });

  test("an edited declaration, or an edit made in Grafana, is updated", async () => {
    const state = emptyGrafana(api);
    await applyGrafana(client(state), planWithEverything(), { marker: MARKER });
    state.dashboards.home.spec.title = "saved in the UI";
    const edited = planFromDashboards([
      { json: dashboard("api", { __elements: { burn: { ...LIB, model: { ...LIB.model, title: "Burn rate" } } } }), folder: "Team A" },
      { json: dashboard("home") },
    ]);
    const out = await applyGrafana(client(state), edited, { marker: MARKER });
    expect(out.applied.map((a) => `${a.action} ${a.kind}/${a.name}`)).toEqual(["unchanged Folder/team-a", "updated LibraryPanel/burn", "updated Dashboard/api", "updated Dashboard/home"]);
    expect(state.dashboards.home.spec.title).toBe("home");
    expect(state.libraryElements.burn).toMatchObject({ version: 2, model: { title: "Burn rate" } });
  });

  test("a foreign dashboard at a declared uid is taken over, keeping its other labels", async () => {
    const state = emptyGrafana(api);
    state.dashboards.home = { spec: { title: "theirs" }, labels: { team: "sre" }, annotations: {} };
    await applyGrafana(client(state), planWithEverything(), { marker: MARKER });
    expect(state.dashboards.home.labels).toEqual({ team: "sre", ...OURS });
  });

  test("prune deletes this project's orphans only, dashboards before folders, children before parents", async () => {
    const state = emptyGrafana(api);
    const other = { ...OURS, "chant.intentius.io/stack": "other" };
    state.dashboards = {
      orphan: { spec: { title: "o" }, labels: OURS, annotations: { "grafana.app/folder": "old-child" } },
      foreign: { spec: { title: "f" }, labels: {}, annotations: {} },
      theirs: { spec: { title: "t" }, labels: other, annotations: {} },
      staging: { spec: { title: "s" }, labels: { ...OURS, "chant.intentius.io/env": "staging" }, annotations: {} },
    };
    state.folders = {
      "old-parent": { spec: { title: "Old" }, labels: OURS, annotations: {} },
      "old-child": { spec: { title: "Old child" }, labels: OURS, annotations: { "grafana.app/folder": "old-parent" } },
      "kept-busy": { spec: { title: "Busy" }, labels: OURS, annotations: {} },
      "their-folder": { spec: { title: "Theirs" }, labels: {}, annotations: {} },
    };
    state.dashboards.saved = { spec: { title: "saved in the UI" }, labels: {}, annotations: { "grafana.app/folder": "kept-busy" } };
    const calls: string[] = [];
    const out = await applyGrafana(client(state, calls), planWithEverything(), { marker: MARKER, prune: true });
    expect(out.pruned.map((p) => `${p.kind}/${p.name}`)).toEqual(["Dashboard/orphan", "Folder/old-child", "Folder/old-parent"]);
    expect(calls.filter((c) => c.startsWith("DELETE")).map((c) => c.split("/").pop())).toEqual(["orphan", "old-child", "old-parent"]);
    expect(Object.keys(state.dashboards).sort()).toEqual(["api", "foreign", "home", "saved", "staging", "theirs"]);
    expect(out.notAttempted).toEqual([expect.objectContaining({ kind: "Folder", name: "kept-busy", reason: "not-prunable", detail: expect.stringContaining("still holds 1 item(s)") })]);
    expect(out.notPrunable).toEqual([{ kind: "LibraryPanel", detail: expect.stringContaining("no labels") }]);
  });

  test("prune without an ownership stack deletes nothing and says why", async () => {
    const state = emptyGrafana(api);
    state.dashboards.orphan = { spec: { title: "o" }, labels: OURS, annotations: {} };
    const calls: string[] = [];
    const out = await applyGrafana(client(state, calls), planFromDashboards([{ json: dashboard("home") }]), { prune: true });
    expect(calls.filter((c) => c.startsWith("DELETE"))).toEqual([]);
    expect(out.notPrunable.map((n) => n.kind)).toEqual(["Dashboard", "Folder"]);
    expect(state.dashboards.home.labels).toEqual({ "app.kubernetes.io/managed-by": "chant" });
  });

  test("a refused token is no-credentials for every resource, with nothing written", async () => {
    const state = { ...emptyGrafana(api), status: 401 };
    const out = await applyGrafana(client(state), planWithEverything(), { marker: MARKER });
    expect(out.applied).toEqual([]);
    expect(out.notAttempted.map((n) => `${n.kind}/${n.name}:${n.reason}`)).toEqual([
      "Folder/team-a:no-credentials",
      "LibraryPanel/burn:no-credentials",
      "Dashboard/api:no-credentials",
      "Dashboard/home:no-credentials",
    ]);
  });

  test("a failed write throws with the status and path", async () => {
    const state = emptyGrafana(api);
    const http = writableGrafana(state);
    const failing = new GrafanaClient(async (method, path, body) => (method === "POST" && path.endsWith("/dashboards") ? { status: 500, json: { message: "boom" } } : http(method, path, body)), TARGET);
    await expect(applyGrafana(failing, planFromDashboards([{ json: dashboard("home") }]), { marker: MARKER })).rejects.toThrow(/POST .*\/dashboards returned 500: boom/);
  });
});

describe("applyGrafana on Grafana 11 (legacy API)", () => {
  test("writes over /api/dashboards/db and /api/folders, unchanged the second time", async () => {
    const state = emptyGrafana("legacy");
    const calls: string[] = [];
    const first = await applyGrafana(client(state, calls), planWithEverything(), { marker: MARKER });
    expect(first.api).toBe("legacy");
    expect(first.applied.map((a) => `${a.action} ${a.kind}/${a.name}`)).toEqual(["created Folder/team-a", "created LibraryPanel/burn", "created Dashboard/api", "created Dashboard/home"]);
    expect(writes(calls)).toEqual(["POST /api/folders", "POST /api/library-elements", "POST /api/dashboards/db", "POST /api/dashboards/db"]);
    expect(state.dashboards.api.annotations).toEqual({ "grafana.app/folder": "team-a" });
    const again: string[] = [];
    const second = await applyGrafana(client(state, again), planWithEverything(), { marker: MARKER });
    expect(second.applied.every((a) => a.action === "unchanged")).toBe(true);
    expect(writes(again)).toEqual([]);
  });

  test("prune cannot read a marker there, so it deletes nothing and reports both kinds", async () => {
    const state = emptyGrafana("legacy");
    state.dashboards.orphan = { spec: { title: "o" }, labels: {}, annotations: {} };
    const calls: string[] = [];
    const out = await applyGrafana(client(state, calls), planFromDashboards([{ json: dashboard("home") }]), { marker: MARKER, prune: true });
    expect(calls.filter((c) => c.startsWith("DELETE"))).toEqual([]);
    expect(out.notPrunable.map((n) => n.kind)).toEqual(["Dashboard", "Folder"]);
  });
});
