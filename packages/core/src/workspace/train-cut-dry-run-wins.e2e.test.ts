/**
 * #5240: `chant workspace train cut --dry-run --yes` stays a dry run. The cut
 * runs in a child chant, with a fake npm first on PATH and a bare remote the
 * members' own dry-run cuts read; nothing is cut, recorded or tagged.
 * #5237: `--plan-only` prints the members and labels and cuts nothing.
 */

import { afterAll, describe, expect, test } from "vitest";
import { spawnSync } from "node:child_process";
import { rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { seedFakeNpmRegistry, writeFakeNpm } from "../lifecycle/__fixtures__/publish-fakes";
import { REPO } from "./__fixtures__/contract-repo";
import { readReleaseTrains } from "./release-train";
import { TestRepo } from "./trust/test-repo";

const repos: TestRepo[] = [];
afterAll(() => {
  for (const r of repos) rmSync(dirname(r.dir), { recursive: true, force: true });
});

const pkg = (name: string, version: string) => `${JSON.stringify({ name, version }, null, 2)}\n`;

describe("chant workspace train cut --dry-run --yes (#5240)", () => {
  test("cuts, records and tags nothing", async () => {
    const r = new TestRepo("train-cut-dry-run");
    repos.push(r);
    r.write("chant.workspace.json", JSON.stringify({ name: "acme", schema: 1, members: [{ name: "npm", dir: "release", kind: "workspace", because: "releases" }] }, null, 2));
    r.write("release/chant.workspace.json", JSON.stringify({ name: "npm", schema: 1, members: ["core", "lex"].map((n) => ({ name: n, dir: n, kind: "chant" })) }, null, 2));
    r.write("release/chant.config.ts", `export default { release: { train: { env: "npm" } } };\n`);
    for (const n of ["core", "lex"]) {
      r.write(`release/${n}/chant.config.ts`, `export default { environments: ["npm"], release: { version: { packages: ["../../pkgs/${n}"], lockfile: false }, publish: [{ type: "npm", stage: false, packages: ["../../pkgs/${n}"] }] } };\n`);
      r.write(`release/${n}/packages.component.ts`, "export const packages = { name: \"packages\", dependsOn: [], deploy: [] };\n");
      r.write(`pkgs/${n}/package.json`, pkg(`@acme/${n}`, "1.0.0"));
    }
    r.write("package.json", `${JSON.stringify({ name: "acme", version: "0.0.0", private: true, workspaces: ["pkgs/*"] }, null, 2)}\n`);
    const head = r.commit("init");
    r.git(["tag", `ci/green/${head}`]);
    const remote = join(dirname(r.dir), "origin.git");
    spawnSync("git", ["init", "-q", "--bare", "-b", "main", remote]);
    r.git(["remote", "add", "origin", remote]);
    r.git(["push", "-q", "origin", "HEAD:main"]);
    r.git(["fetch", "-q", "origin"]);
    const log = join(dirname(r.dir), "npm.log");
    seedFakeNpmRegistry(log, { packages: { "@acme/core": { versions: ["1.0.0"], distTags: { latest: "1.0.0" } }, "@acme/lex": { versions: ["1.0.0"], distTags: { latest: "1.0.0" } } } });
    const npm = writeFakeNpm(join(dirname(r.dir), "bin"), log);

    const cli = [process.execPath, "--import", pathToFileURL(join(REPO, "node_modules", "tsx", "dist", "loader.mjs")).href, join(REPO, "packages", "core", "src", "cli", "main.ts")];
    const nested = join(r.dir, "release");
    const run = spawnSync(cli[0]!, [...cli.slice(1), "workspace", "train", "cut", "npm", "--dry-run", "--yes", "--no-push", "--json"], {
      cwd: nested,
      encoding: "utf-8",
      env: { ...process.env, PATH: `${dirname(npm)}:${process.env.PATH}`, USER: "tester" },
      timeout: 120_000,
    });
    expect(run.status, run.stderr).toBe(0);
    expect(JSON.parse(run.stdout)).toMatchObject({ dryRun: true });
    expect(r.git(["tag", "-l", "release/*"]).trim()).toBe("");
    expect((await readReleaseTrains(nested, "npm")).records).toEqual([]);

    // #5237: --plan-only prints the plan a workflow's gate hands the build jobs, with no member's dry run, and cuts nothing.
    const env = { ...process.env, PATH: `${dirname(npm)}:${process.env.PATH}`, USER: "tester" };
    const plan = spawnSync(cli[0]!, [...cli.slice(1), "workspace", "train", "cut", "npm", "--plan-only", "--json"], { cwd: nested, encoding: "utf-8", env, timeout: 120_000 });
    expect(plan.status, plan.stderr).toBe(0);
    expect(JSON.parse(plan.stdout)).toMatchObject({ dryRun: true, planOnly: true, planned: "core=1.0.1,lex=1.0.1" });
    const refused = spawnSync(cli[0]!, [...cli.slice(1), "workspace", "train", "cut", "npm", "--plan-only", "--yes", "--json"], { cwd: nested, encoding: "utf-8", env, timeout: 120_000 });
    expect(refused.status).toBe(1);
    expect(JSON.parse(refused.stdout)).toMatchObject({ status: "refused", code: "train-plan-only" });
    expect(r.git(["tag", "-l", "release/*"]).trim()).toBe("");
  }, 180_000);
});
