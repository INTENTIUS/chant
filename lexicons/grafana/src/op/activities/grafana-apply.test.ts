import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import { describeApplyConformance } from "@intentius/chant-test-utils";
import { normalizeApply } from "@intentius/chant/apply";
import { grafanaApply, readBuiltDashboards, resolveMarker, toApplyResult, type GrafanaApplyDeps } from "./grafana-apply";
import { emptyGrafana, writableGrafana, type WritableGrafanaState } from "../../api/fake-grafana-writes";
import type { GrafanaHttp } from "../../api/client";

type Json = Record<string, unknown>;

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

const OURS = { "app.kubernetes.io/managed-by": "chant", "chant.intentius.io/stack": "shop", "chant.intentius.io/env": "prod" };

function dashboard(uid: string, extra: Json = {}): Json {
  return { uid, title: uid, schemaVersion: 41, panels: [{ id: 1, type: "stat", title: "a", gridPos: { x: 0, y: 0, w: 6, h: 4 } }], ...extra };
}

/** Write a build output the way `chant build -o <dir>/grafana.json` does: the index, and the dashboard files beside it. */
function buildOutput(dashboards: Array<{ json: Json; folder?: string }>, opts: { combined?: boolean } = {}): string {
  const dir = mkdtempSync(join(tmpdir(), "chant-grafana-apply-"));
  dirs.push(dir);
  const entries = dashboards.map(({ json, folder }) => {
    const file = folder ? `dashboards/${folder}/${json.uid}.json` : `dashboards/${json.uid}.json`;
    mkdirSync(dirname(join(dir, file)), { recursive: true });
    writeFileSync(join(dir, file), JSON.stringify(json));
    return { uid: json.uid, title: json.title, ...(folder ? { folder } : {}), file };
  });
  const index = { grafanaSchema: "test", dashboards: entries, datasources: [], files: entries.map((e) => e.file) };
  const indexPath = join(dir, "grafana.json");
  writeFileSync(indexPath, JSON.stringify(opts.combined ? { grafana: index, otel: {} } : index));
  return indexPath;
}

function deps(state: WritableGrafanaState, extra: Partial<GrafanaApplyDeps> = {}, calls: string[] = []): GrafanaApplyDeps {
  return {
    http: writableGrafana(state, calls),
    config: { grafana: { profiles: { test: { url: "http://grafana.test" } } }, ownership: { stack: "shop", env: "prod" } },
    env: {},
    ...extra,
  };
}

describe("readBuiltDashboards", () => {
  test("reads the index and the files it lists, with their folders", () => {
    const indexPath = buildOutput([{ json: dashboard("a"), folder: "Team A" }, { json: dashboard("b") }]);
    expect(readBuiltDashboards(indexPath)).toEqual([
      { json: dashboard("a"), folder: "Team A" },
      { json: dashboard("b") },
    ]);
  });

  test("reads the grafana key of a combined multi-lexicon output", () => {
    expect(readBuiltDashboards(buildOutput([{ json: dashboard("a") }], { combined: true }))).toEqual([{ json: dashboard("a") }]);
  });

  test("refuses a file that is not a grafana index", () => {
    const dir = mkdtempSync(join(tmpdir(), "chant-grafana-apply-"));
    dirs.push(dir);
    writeFileSync(join(dir, "x.json"), "{}");
    expect(() => readBuiltDashboards(join(dir, "x.json"))).toThrow(/not a grafana build index/);
  });
});

describe("resolveMarker", () => {
  test("arguments win over the project's ownership config", () => {
    expect(resolveMarker({}, { ownership: { stack: "shop", env: "prod" } })).toEqual({ stack: "shop", env: "prod" });
    expect(resolveMarker({ stack: "x", ownershipEnv: "dev" }, { ownership: { stack: "shop", env: "prod" } })).toEqual({ stack: "x", env: "dev" });
    expect(resolveMarker({}, { ownership: { stack: "shop", enabled: false } })).toBeUndefined();
    expect(resolveMarker({}, undefined)).toBeUndefined();
  });

  test("an env that is a build parameter reference needs ownershipEnv", () => {
    expect(() => resolveMarker({}, { ownership: { stack: "shop", env: { param: "env" } } })).toThrow(/pass ownershipEnv/);
    expect(resolveMarker({ ownershipEnv: "prod" }, { ownership: { stack: "shop", env: { param: "env" } } })).toEqual({ stack: "shop", env: "prod" });
  });
});

describe("grafanaApply", () => {
  test("binds grafana.profiles.<environment> and applies", async () => {
    const state = emptyGrafana("v1");
    const out = await grafanaApply({ indexPath: buildOutput([{ json: dashboard("a"), folder: "Team A" }]), environment: "test" }, undefined, deps(state));
    expect(out.target).toBe("grafana.profiles.test");
    expect(out.applied.map((a) => `${a.action} ${a.kind}/${a.name}`)).toEqual(["created Folder/team-a", "created Dashboard/a"]);
    expect(state.dashboards.a.labels).toEqual(OURS);
  });

  test("no Grafana to bind is no-binding for every resource, with nothing sent", async () => {
    const calls: string[] = [];
    const out = await grafanaApply({ indexPath: buildOutput([{ json: dashboard("a"), folder: "Team A" }]), environment: "nowhere" }, undefined, deps(emptyGrafana("v1"), {}, calls));
    expect(calls).toEqual([]);
    expect(normalizeApply(toApplyResult(out)).notAttempted.map((n) => `${n.kind}/${n.name}:${n.reason}`)).toEqual(["Folder/team-a:no-binding", "Dashboard/a:no-binding"]);
  });

  test("a profile whose token variable is unset is no-credentials", async () => {
    const out = await grafanaApply(
      { indexPath: buildOutput([{ json: dashboard("a") }]), environment: "test" },
      undefined,
      deps(emptyGrafana("v1"), { config: { grafana: { profiles: { test: { url: "http://grafana.test", token: { env: "UNSET_TOKEN" } } } } } }),
    );
    expect(out.notAttempted).toEqual([expect.objectContaining({ kind: "Dashboard", name: "a", reason: "no-credentials", detail: expect.stringContaining("UNSET_TOKEN") })]);
  });

  test("toApplyResult keeps the request path and reports an unconsidered kind as <kind>/*", async () => {
    const state = emptyGrafana("legacy");
    const out = await grafanaApply({ indexPath: buildOutput([{ json: dashboard("a") }]), environment: "test", prune: true }, undefined, deps(state));
    const result = normalizeApply(toApplyResult(out));
    expect(result.applied).toEqual([{ kind: "Dashboard", name: "a", action: "created", physicalId: "/api/dashboards/uid/a" }]);
    expect(result.notAttempted.map((n) => `${n.kind}/${n.name}:${n.reason}`)).toEqual(["Dashboard/*:not-prunable", "Folder/*:not-prunable"]);
  });
});

// ── The shared apply conformance suite (applying-conformance.mdx) ──────────

/** Apply one build against `state`, recording every delete path the transport was asked for. */
async function run(state: WritableGrafanaState, dashboards: Array<{ json: Json; folder?: string }>, opts: { prune?: boolean } = {}) {
  const deletes: string[] = [];
  const base = writableGrafana(state);
  const http: GrafanaHttp = async (method, path, body) => {
    if (method === "DELETE") deletes.push(path);
    return base(method, path, body);
  };
  const outcome = await grafanaApply({ indexPath: buildOutput(dashboards), environment: "test", ...(opts.prune ? { prune: true } : {}) }, undefined, deps(state, { http }));
  return { result: toApplyResult(outcome), deletes };
}

const LIB = { uid: "burn", name: "Burn", kind: 1, model: { type: "stat", title: "Burn" } };
const LIB_VAR = { uid: "region", name: "Region", kind: 2, model: {} };

describeApplyConformance({
  lexicon: "grafana",
  scenarios: [
    {
      name: "a folder, a library panel and two dashboards on Grafana 13 (v1)",
      plan: [
        { kind: "Folder", name: "team-a" },
        { kind: "LibraryPanel", name: "burn" },
        { kind: "Dashboard", name: "api" },
        { kind: "Dashboard", name: "home" },
      ],
      run: async () => (await run(emptyGrafana("v1"), [{ json: dashboard("api", { __elements: { burn: LIB } }), folder: "Team A" }, { json: dashboard("home") }])).result,
      expectApplied: ["Folder/team-a", "LibraryPanel/burn", "Dashboard/api", "Dashboard/home"],
    },
    {
      name: "a library variable in __elements beside a dashboard on Grafana 12.4 (v1beta1)",
      plan: [
        { kind: "Dashboard", name: "api" },
        { kind: "LibraryElement", name: "region" },
      ],
      run: async () => (await run(emptyGrafana("v1beta1"), [{ json: dashboard("api", { __elements: { region: LIB_VAR } }) }])).result,
      expectApplied: ["Dashboard/api"],
      expectNotAttempted: ["LibraryElement/region"],
    },
    {
      name: "a refused token",
      plan: [
        { kind: "Folder", name: "team-a" },
        { kind: "Dashboard", name: "api" },
      ],
      run: async () => (await run({ ...emptyGrafana("v1"), status: 403 }, [{ json: dashboard("api"), folder: "Team A" }])).result,
      expectNotAttempted: ["Folder/team-a", "Dashboard/api"],
    },
    {
      name: "prune on Grafana 11, which has no marker channel",
      plan: [{ kind: "Dashboard", name: "api" }],
      run: async () => (await run(emptyGrafana("legacy"), [{ json: dashboard("api") }], { prune: true })).result,
      expectApplied: ["Dashboard/api"],
      expectNotAttempted: ["Dashboard/*", "Folder/*"],
    },
  ],
  pruneScenarios: [
    {
      name: "an owned orphan dashboard beside one saved in the UI",
      ownedOrphan: "/dashboards/orphan",
      foreign: "/dashboards/foreign",
      run: async () => {
        const state = emptyGrafana("v1");
        state.dashboards.orphan = { spec: { title: "o" }, labels: OURS, annotations: {} };
        state.dashboards.foreign = { spec: { title: "f" }, labels: {}, annotations: {} };
        return run(state, [{ json: dashboard("keep") }], { prune: true });
      },
    },
    {
      name: "an owned orphan dashboard beside another chant stack's",
      ownedOrphan: "/dashboards/orphan",
      foreign: "/dashboards/other-stack",
      run: async () => {
        const state = emptyGrafana("v1beta1");
        state.dashboards.orphan = { spec: { title: "o" }, labels: OURS, annotations: {} };
        state.dashboards["other-stack"] = { spec: { title: "x" }, labels: { ...OURS, "chant.intentius.io/stack": "billing" }, annotations: {} };
        return run(state, [{ json: dashboard("keep") }], { prune: true });
      },
    },
    {
      name: "an owned orphan folder beside a foreign one",
      ownedOrphan: "/folders/old-team",
      foreign: "/folders/their-team",
      run: async () => {
        const state = emptyGrafana("v1");
        state.folders["old-team"] = { spec: { title: "Old team" }, labels: OURS, annotations: {} };
        state.folders["their-team"] = { spec: { title: "Their team" }, labels: {}, annotations: {} };
        return run(state, [{ json: dashboard("keep"), folder: "Team A" }], { prune: true });
      },
    },
  ],
  idempotenceScenarios: [
    {
      name: "the same build applied twice on Grafana 13 (v1)",
      run: async () => {
        const state = emptyGrafana("v1");
        const build = [{ json: dashboard("api", { __elements: { burn: LIB } }), folder: "Team A" }, { json: dashboard("home") }];
        return { first: (await run(state, build)).result, second: (await run(state, build)).result };
      },
    },
    {
      name: "the same build applied twice on Grafana 11 (legacy API)",
      run: async () => {
        const state = emptyGrafana("legacy");
        const build = [{ json: dashboard("api"), folder: "Team A" }];
        return { first: (await run(state, build)).result, second: (await run(state, build)).result };
      },
    },
  ],
});
