/**
 * The API applier (#2948) against Grafana itself, 12.4.11 and 13.2.2.
 *
 * Per image, one project is built and applied with `grafanaApply`, the Op
 * activity, through its build output (the index and the dashboard files):
 *
 * 1. Apply: three folders (one nested in another, with a pinned uid), a
 *    library panel and three dashboards are created, each dashboard and
 *    folder labelled with the project's marker.
 * 2. Re-apply: nothing is created, and nothing is written.
 * 3. A panel title is edited in the source and applied: that dashboard is
 *    updated, the rest unchanged.
 * 4. A dashboard is removed from the source and applied with `prune`: it is
 *    deleted; a dashboard created directly in Grafana survives, and so does
 *    the removed dashboard's folder, since somebody saved a dashboard of
 *    their own into it.
 * 5. Once that dashboard is gone, the next prune deletes the empty folder.
 *
 * The build does not write `__elements` yet (library panels are not
 * declared in the lexicon), so the library panel is added to one built
 * dashboard's file the way an exported dashboard carries it.
 *
 * Containers come from ../../../test/e2e/containers.ts (unique names,
 * random host ports, removed in afterAll even on failure;
 * `CHANT_GRAFANA_IMAGES` overrides the image pair). Skipped, with the reason
 * in the test name, when Docker is not running. Run through the slot lock:
 * `~/checkouts/intentius/chant-worktrees/.docker-slot.sh <label> -- npx vitest run lexicons/grafana/src/op/activities/grafana-apply.e2e.test.ts`
 */

import { mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { build } from "@intentius/chant/build";
import type { SerializerResult } from "@intentius/chant/serializer";
import { grafanaSerializer } from "../../serializer";
import { grafanaApply, type GrafanaApplyDeps, type GrafanaApplyOutcome } from "./grafana-apply";
import { DockerScope, GRAFANA_IMAGES, dockerAvailable, type GrafanaContainer } from "../../../test/e2e/containers";

const hasDocker = dockerAvailable();
const skipReason = hasDocker ? "" : " (skipped: Docker is not running)";
const repoRoot = resolve(import.meta.dirname, "..", "..", "..", "..", "..");

const MARKER_LABELS = { "app.kubernetes.io/managed-by": "chant", "chant.intentius.io/stack": "e2e-shop", "chant.intentius.io/env": "e2e" };
const LIBRARY_PANEL = { uid: "chant-e2e-burn", name: "Error budget burn", kind: 1, model: { type: "stat", title: "Error budget burn", description: "shared" } };

function source(opts: { requestsTitle: string; withErrors: boolean }): string {
  return `import { Dashboard, Folder, StatPanel } from "@intentius/chant-lexicon-grafana";

export const requests = new StatPanel({ title: ${JSON.stringify(opts.requestsTitle)} });
export const latency = new StatPanel({ title: "Latency" });
export const fiveHundreds = new StatPanel({ title: "5xx" });
export const apiOverview = new Dashboard({ title: "API overview", folder: "Team A", tags: ["api"], panels: [requests, latency] });
${opts.withErrors ? `export const errors = new Dashboard({ title: "Errors", folder: "Team B", panels: [fiveHundreds] });\n` : ""}export const teamA = new Folder({ title: "Team A" });
export const payments = new Folder({ title: "Payments", uid: "chant-e2e-payments", parent: teamA });
export const home = new Dashboard({ title: "Home", folder: payments });
`;
}

const summary = (o: GrafanaApplyOutcome) => o.applied.map((a) => `${a.action} ${a.kind}/${a.name}`).sort();

describe.skipIf(!hasDocker).each(GRAFANA_IMAGES)(`grafanaApply applies, re-applies, updates and prunes against %s${skipReason}`, (image) => {
  const scope = new DockerScope("grafana-apply");
  let project = "";
  let indexPath = "";
  let grafana: GrafanaContainer;
  let deps: GrafanaApplyDeps;

  /**
   * Build the project as `opts` declares it, into `dist/`, with the library
   * panel added to api-overview's file. Each build is a fresh project
   * directory: the build imports the source modules, and a module path
   * already imported in this process would be served from the cache.
   */
  const buildProject = async (opts: { requestsTitle: string; withErrors: boolean }) => {
    project = join(scope.tempDir(), "project");
    mkdirSync(join(project, "src"), { recursive: true });
    writeFileSync(join(project, "package.json"), JSON.stringify({ name: "grafana-apply-e2e", private: true, type: "module" }));
    symlinkSync(join(repoRoot, "node_modules"), join(project, "node_modules"), "dir");
    writeFileSync(join(project, "src", "dashboards.ts"), source(opts));
    const result = await build(join(project, "src"), [grafanaSerializer]);
    expect(result.errors).toEqual([]);
    const out = result.outputs.get("grafana") as SerializerResult;
    const dist = join(project, "dist");
    rmSync(dist, { recursive: true, force: true });
    for (const [file, content] of Object.entries(out.files ?? {})) {
      mkdirSync(dirname(join(dist, file)), { recursive: true });
      writeFileSync(join(dist, file), content);
    }
    indexPath = join(dist, "grafana.json");
    writeFileSync(indexPath, out.primary);
    const index = JSON.parse(out.primary) as { dashboards: Array<{ uid: string; file: string }> };
    const file = join(dist, index.dashboards.find((d) => d.uid === "api-overview")!.file);
    const json = JSON.parse(readFileSync(file, "utf8")) as { panels: unknown[] } & Record<string, unknown>;
    json.__elements = { [LIBRARY_PANEL.uid]: LIBRARY_PANEL };
    json.panels.push({ id: 99, gridPos: { x: 0, y: 20, w: 12, h: 6 }, libraryPanel: { uid: LIBRARY_PANEL.uid, name: LIBRARY_PANEL.name } });
    writeFileSync(file, JSON.stringify(json, null, 2));
  };

  const apply = (prune = false) => grafanaApply({ indexPath, environment: "e2e", ...(prune ? { prune: true } : {}) }, undefined, deps);
  const dashboard = (uid: string) => grafana.api(`/api/dashboards/uid/${uid}`);
  const saveForeign = (uid: string, folderUid = "") =>
    grafana.api("/api/dashboards/db", { method: "POST", body: JSON.stringify({ dashboard: { uid, title: `Saved in the UI (${uid})` }, folderUid, overwrite: true }) });

  beforeAll(async () => {
    grafana = await scope.grafana({ image });
    deps = {
      config: {
        grafana: { profiles: { e2e: { url: grafana.base, basicAuth: { user: { env: "E2E_GRAFANA_USER" }, password: { env: "E2E_GRAFANA_PASSWORD" } } } } },
        ownership: { stack: "e2e-shop", env: "e2e" },
      },
      env: { E2E_GRAFANA_USER: "admin", E2E_GRAFANA_PASSWORD: "admin" },
    };
    expect((await saveForeign("foreign-home")).status).toBe(200);
  }, 300_000);

  afterAll(() => scope.cleanup());

  it("apply: creates the folders, nested ones under their parent, the library panel and the dashboards, labelled with the marker", { timeout: 240_000 }, async () => {
    await buildProject({ requestsTitle: "Requests", withErrors: true });
    const out = await apply();
    expect(out.api).toMatch(/^apis\/v1(beta1)?$/);
    expect(out.notAttempted).toEqual([]);
    expect(summary(out)).toEqual([
      "created Dashboard/api-overview",
      "created Dashboard/errors",
      "created Dashboard/home",
      "created Folder/chant-e2e-payments",
      "created Folder/team-a",
      "created Folder/team-b",
      "created LibraryPanel/chant-e2e-burn",
    ]);

    const path = out.applied.find((a) => a.name === "api-overview")!.address;
    const live = (await grafana.api(path)).body as { metadata: { labels: Record<string, string>; annotations: Record<string, string> } };
    expect(live.metadata.labels).toMatchObject(MARKER_LABELS);
    expect(live.metadata.annotations["grafana.app/folder"]).toBe("team-a");
    const folder = (await grafana.api(out.applied.find((a) => a.name === "team-a")!.address)).body as { metadata: { labels: Record<string, string> }; spec: { title: string } };
    expect(folder.metadata.labels).toMatchObject(MARKER_LABELS);
    expect(folder.spec.title).toBe("Team A");
    const nested = (await grafana.api("/api/folders/chant-e2e-payments")).body as { title: string; parentUid?: string; parents?: Array<{ uid: string }> };
    expect(nested.title).toBe("Payments");
    expect(nested.parentUid ?? nested.parents?.[0]?.uid).toBe("team-a");
    const home = (await grafana.api(out.applied.find((a) => a.name === "home")!.address)).body as { metadata: { annotations: Record<string, string> } };
    expect(home.metadata.annotations["grafana.app/folder"]).toBe("chant-e2e-payments");
    const connections = (await grafana.api(`/api/library-elements/${LIBRARY_PANEL.uid}/connections`)).body as { result: Array<{ connectionUid: string }> };
    expect(connections.result.map((c) => c.connectionUid)).toEqual(["api-overview"]);
  });

  it("re-apply: nothing is created and nothing changes", { timeout: 240_000 }, async () => {
    const out = await apply();
    expect(out.applied.filter((a) => a.action === "created")).toEqual([]);
    expect(out.applied.filter((a) => a.action !== "unchanged")).toEqual([]);
  });

  it("an edited declaration: that dashboard is updated, the rest unchanged", { timeout: 240_000 }, async () => {
    await buildProject({ requestsTitle: "Requests per second", withErrors: true });
    const out = await apply();
    expect(out.applied.filter((a) => a.action !== "unchanged").map((a) => `${a.action} ${a.kind}/${a.name}`)).toEqual(["updated Dashboard/api-overview"]);
    const body = (await dashboard("api-overview")).body as { dashboard: { panels: Array<{ title?: string }> } };
    expect(body.dashboard.panels.map((p) => p.title)).toContain("Requests per second");
  });

  it("a removed declaration is pruned; what Grafana users made survives, and so does the folder they saved into", { timeout: 240_000 }, async () => {
    expect((await saveForeign("foreign-in-b", "team-b")).status).toBe(200);
    await buildProject({ requestsTitle: "Requests per second", withErrors: false });
    const out = await apply(true);
    expect(out.pruned.map((p) => `${p.kind}/${p.name}:${p.deleted}`)).toEqual(["Dashboard/errors:true"]);
    expect(out.notAttempted).toEqual([expect.objectContaining({ kind: "Folder", name: "team-b", reason: "not-prunable" })]);
    expect((await dashboard("errors")).status).toBe(404);
    expect((await dashboard("foreign-home")).status).toBe(200);
    expect((await dashboard("foreign-in-b")).status).toBe(200);
    expect((await dashboard("api-overview")).status).toBe(200);
    expect((await dashboard("home")).status).toBe(200);
  });

  it("once the folder is empty, the next prune deletes it", { timeout: 240_000 }, async () => {
    expect((await grafana.api("/api/dashboards/uid/foreign-in-b", { method: "DELETE" })).status).toBe(200);
    const out = await apply(true);
    expect(out.pruned.map((p) => `${p.kind}/${p.name}:${p.deleted}`)).toEqual(["Folder/team-b:true"]);
    expect(out.notAttempted).toEqual([]);
    expect((await grafana.api("/api/folders/team-b")).status).toBe(404);
    expect((await grafana.api("/api/folders/team-a")).status).toBe(200);
  });
});
