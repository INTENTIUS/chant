/**
 * "A dashboard edited in Grafana's UI shows as drift in `chant lifecycle
 * diff --live`" (#2946, #2960), against Grafana itself, 12.4.11 and 13.2.2.
 *
 * Per image: a small project (a datasource, a dashboard with a variable and
 * a row of panels, a provider that allows UI saves) is built, its
 * provisioning files and dashboards are mounted into a fresh container, and
 * this checkout's `chant lifecycle diff <env> --live --json` is run in the
 * project:
 *
 * 1. Untouched: every declared entity present, the dashboard `owned` (its
 *    provider is chant's), no drift and nothing unclaimed.
 * 2. Then the dashboard is saved through `POST /api/dashboards/db`, the call
 *    the dashboard editor's Save makes, with one query and one panel title
 *    changed. The same command reports exactly those two paths as drift.
 * 3. Live export of the environment generates TypeScript that carries the
 *    edit, and the generated project builds.
 *
 * Containers come from the shared helpers in ../test/e2e/containers.ts
 * (unique names, random host ports, removed in afterAll even on failure;
 * `CHANT_GRAFANA_IMAGES` overrides the image pair). Skipped, with the reason
 * in the test name, when Docker is not running. Run through the slot lock:
 * `~/checkouts/intentius/chant-worktrees/.docker-slot.sh <label> -- npx vitest run lexicons/grafana/src/observe.e2e.test.ts`
 */

import { execSync, spawn } from "node:child_process";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { build } from "@intentius/chant/build";
import type { SerializerResult } from "@intentius/chant/serializer";
import { grafanaSerializer } from "./serializer";
import { exportResources } from "./export-resources";
import { GrafanaGenerator } from "./import/generator";
import { DockerScope, GRAFANA_IMAGES, dockerAvailable, waitFor, type GrafanaContainer } from "../test/e2e/containers";

const hasDocker = dockerAvailable();
const skipReason = hasDocker ? "" : " (skipped: Docker is not running)";
const repoRoot = resolve(import.meta.dirname, "..", "..", "..");

const PROJECT: Record<string, string> = {
  "src/datasources.ts": `import { Datasource } from "@intentius/chant-lexicon-grafana";

export const prometheus = new Datasource({ name: "Prometheus", type: "prometheus", url: "http://prometheus:9090", isDefault: true });
`,
  "src/panels.ts": `import { PromQuery, Row, StatPanel, TimeSeriesPanel, CustomVariable } from "@intentius/chant-lexicon-grafana";
import { prometheus } from "./datasources";

export const job = new CustomVariable({ name: "job", values: ["api", "worker"] });
export const rate = new PromQuery({ expr: 'sum(rate(http_requests_total{job="$job"}[5m]))', datasource: prometheus });
export const errors = new PromQuery({ expr: 'sum(rate(http_requests_total{job="$job", code=~"5.."}[5m]))', datasource: prometheus });
const rateUnit = { defaults: { unit: "reqps" } };
export const ratePanel = new TimeSeriesPanel({ title: "Request rate", targets: [rate], fieldConfig: rateUnit });
export const errorPanel = new StatPanel({ title: "Errors", targets: [errors] });
export const traffic = new Row({ title: "Traffic", panels: [ratePanel, errorPanel] });
`,
  "src/dashboard.ts": `import { Dashboard, DashboardProvider } from "@intentius/chant-lexicon-grafana";
import { job, traffic } from "./panels";

const lastHour = { from: "now-1h", to: "now" };
export const apiOverview = new Dashboard({ title: "API overview", tags: ["api"], time: lastHour, variables: [job], panels: [traffic] });
export const provider = new DashboardProvider({ name: "chant", allowUiUpdates: true, updateIntervalSeconds: 3600 });
`,
};

/** This checkout's chant, run in `cwd`. */
function chant(cwd: string, env: Record<string, string>, ...args: string[]): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((done) => {
    const child = spawn(
      process.execPath,
      ["--import", pathToFileURL(join(repoRoot, "node_modules/tsx/dist/loader.mjs")).href, join(repoRoot, "packages/core/src/cli/main.ts"), ...args],
      { cwd, env: { ...process.env, NO_COLOR: "1", ...env } },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    const timer = setTimeout(() => child.kill(), 240_000);
    child.on("close", (status) => {
      clearTimeout(timer);
      done({ status, stdout, stderr });
    });
  });
}

interface LiveDiffJson {
  lexicons: {
    grafana: {
      resources: { missing: string[]; unobserved: Array<{ name: string; reason: string }> };
      observed: Record<string, { ownership?: string; status: string }>;
      deep: {
        drifted: Array<{ name: string; changes: Array<{ path: string; kind: string; declared?: unknown; live?: unknown }> }>;
        unclaimed: Array<{ name: string; fields: Array<{ path: string }> }>;
        unchanged: string[];
      };
    };
  };
}

describe.skipIf(!hasDocker).each(GRAFANA_IMAGES)(`a dashboard edited in Grafana shows as drift in chant lifecycle diff --live: %s${skipReason}`, (image) => {
  const scope = new DockerScope("grafana-observe");
  let dir = "";
  let project = "";
  let grafana: GrafanaContainer;
  const env = { E2E_GRAFANA_USER: "admin", E2E_GRAFANA_PASSWORD: "admin", GRAFANA_URL: "", GRAFANA_TOKEN: "" };
  const profile = () => ({ url: grafana.base, basicAuth: { user: { env: "E2E_GRAFANA_USER" }, password: { env: "E2E_GRAFANA_PASSWORD" } } });

  const diff = async (): Promise<LiveDiffJson> => {
    const r = await chant(project, env, "lifecycle", "diff", "e2e", "--live", "--json");
    const line = r.stdout.trim().split("\n").filter((l) => l.startsWith("{")).pop();
    if (!line) throw new Error(`no JSON from chant lifecycle diff (exit ${r.status}):\n${r.stdout}\n${r.stderr}`);
    return JSON.parse(line) as LiveDiffJson;
  };

  beforeAll(async () => {
    dir = scope.tempDir();
    project = join(dir, "project");
    const mounted = join(dir, "mounted");
    for (const [file, content] of Object.entries(PROJECT)) {
      mkdirSync(dirname(join(project, file)), { recursive: true });
      writeFileSync(join(project, file), content);
    }
    writeFileSync(join(project, "package.json"), JSON.stringify({ name: "grafana-observe-e2e", private: true, type: "module" }));
    symlinkSync(join(repoRoot, "node_modules"), join(project, "node_modules"), "dir");
    execSync("git init -q && git -c user.email=e2e@example.com -c user.name=e2e commit -q --allow-empty -m init", { cwd: project });

    const result = await build(join(project, "src"), [grafanaSerializer]);
    expect(result.errors).toEqual([]);
    const out = result.outputs.get("grafana") as SerializerResult;
    for (const [file, content] of Object.entries(out.files ?? {})) {
      mkdirSync(dirname(join(mounted, file)), { recursive: true });
      writeFileSync(join(mounted, file), content);
    }

    grafana = await scope.grafana({ image, provisioningDir: join(mounted, "provisioning"), dashboardsDir: join(mounted, "dashboards") });
    writeFileSync(join(project, "chant.config.ts"), `export default { lexicons: ["grafana"], grafana: { profiles: { e2e: ${JSON.stringify(profile())} } } };\n`);

    await waitFor("the dashboard to be provisioned", async () => ((await grafana.api("/api/dashboards/uid/api-overview")).status === 200 ? true : undefined));
    await waitFor("the datasource to be provisioned", async () => ((await grafana.api("/api/datasources/uid/prometheus")).status === 200 ? true : undefined));
  }, 300_000);

  afterAll(() => scope.cleanup());

  it("an untouched dashboard: present, chant's, no drift, nothing unclaimed", { timeout: 300_000 }, async () => {
    const { grafana } = (await diff()).lexicons;
    expect(grafana.resources.missing).toEqual([]);
    expect(grafana.observed.apiOverview).toMatchObject({ status: "PRESENT", ownership: "owned" });
    expect(grafana.observed.prometheus).toMatchObject({ status: "PRESENT" });
    // Only the provider is not observed: Grafana serves no API for it.
    expect(grafana.resources.unobserved.map((u) => `${u.name}:${u.reason}`)).toEqual(["provider:unsupported-kind"]);
    expect(grafana.deep.drifted).toEqual([]);
    expect(grafana.deep.unclaimed).toEqual([]);
    expect(grafana.deep.unchanged).toEqual(expect.arrayContaining(["apiOverview", "prometheus"]));
  });

  it("the same dashboard saved from the editor with a changed query and title: exactly those paths drift", { timeout: 300_000 }, async () => {
    const { body } = await grafana.api("/api/dashboards/uid/api-overview");
    const dashboard = body.dashboard as { panels: Array<{ title: string; targets?: Array<{ expr?: string }> }> };
    const rate = dashboard.panels.find((p) => p.title === "Request rate")!;
    rate.targets![0].expr = "sum(rate(http_requests_total[1m]))";
    dashboard.panels.find((p) => p.title === "Errors")!.title = "5xx";
    const saved = await grafana.api("/api/dashboards/db", { method: "POST", body: JSON.stringify({ dashboard, overwrite: true, message: "edited in the UI" }) });
    expect(saved.status).toBe(200);

    const { grafana } = (await diff()).lexicons;
    const changes = grafana.deep.drifted.find((d) => d.name === "apiOverview")?.changes ?? [];
    expect(changes.map((c) => ({ path: c.path, kind: c.kind, live: c.live })).sort((a, b) => a.path.localeCompare(b.path))).toEqual([
      { path: "panels[0].panels[0].targets[0].expr", kind: "changed", live: "sum(rate(http_requests_total[1m]))" },
      { path: "panels[0].panels[1].title", kind: "changed", live: "5xx" },
    ]);
    expect(grafana.deep.drifted.map((d) => d.name)).toEqual(["apiOverview"]);
  });

  it("live export generates TypeScript that carries the edit and builds", { timeout: 240_000 }, async () => {
    const ir = await exportResources({
      environment: "e2e",
      config: { grafana: { profiles: { e2e: profile() } } },
      env,
    });
    const files = new GrafanaGenerator().generate(ir);
    const source = files.map((f) => f.content).join("\n");
    expect(source).toContain("sum(rate(http_requests_total[1m]))");
    expect(source).toContain('"5xx"');

    // The generated project builds: the exported Datasource and the dashboard's reference to it do not collide.
    const exported = join(dir, "exported");
    for (const f of files) {
      mkdirSync(dirname(join(exported, "src", f.path)), { recursive: true });
      writeFileSync(join(exported, "src", f.path), f.content);
    }
    writeFileSync(join(exported, "package.json"), JSON.stringify({ name: "grafana-export-e2e", private: true, type: "module" }));
    writeFileSync(join(exported, "chant.config.ts"), 'export default { lexicons: ["grafana"] };\n');
    symlinkSync(join(repoRoot, "node_modules"), join(exported, "node_modules"), "dir");
    const built = await chant(exported, {}, "build", "src", "--lexicon", "grafana", "-o", join(exported, "dist", "index.json"));
    expect(built.status, `${built.stdout}\n${built.stderr}`).toBe(0);
  });
});
