/**
 * #5240: `--dry-run` wins over `--yes` in every release command that takes
 * both. Each test passes both flags and checks that nothing was written: no
 * publish, no status change, no composed branch, no files from init, no cut.
 * A temp repo with a temp bare remote; nothing is published anywhere.
 */

import { describe, test, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { REPO } from "../../workspace/__fixtures__/contract-repo";

const CHANT = [process.execPath, "--import", pathToFileURL(join(REPO, "node_modules", "tsx", "dist", "loader.mjs")).href, join(REPO, "packages", "core", "src", "cli", "main.ts")];
const CI_VARS = ["CI", "GITHUB_ACTIONS", "GITHUB_RUN_ID", "GITHUB_SHA", "GITHUB_ACTOR", "GITHUB_REPOSITORY", "GITLAB_CI", "CI_PIPELINE_ID", "CHANT_ENV", "CHANT_RELEASE_LABEL"];

function chant(cwd: string, args: string[]): { code: number; stdout: string; stderr: string } {
  const env: NodeJS.ProcessEnv = { ...process.env, USER: "tester" };
  for (const k of CI_VARS) delete env[k];
  const r = spawnSync(CHANT[0], [...CHANT.slice(1), ...args], { cwd, encoding: "utf-8", env, timeout: 120_000 });
  return { code: r.status ?? 1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

function git(cwd: string, ...args: string[]): string {
  const r = spawnSync("git", args, { cwd, encoding: "utf-8" });
  if (r.status !== 0) throw new Error(r.stderr);
  return r.stdout.trim();
}

const refs = (dir: string) => git(dir, "for-each-ref", "--format=%(refname) %(objectname)");
const BUILD = `mkdir -p dist && printf '{"env":"%s"}' "$CHANT_ENV" > dist/api.template.json`;

/** A member with one green commit on main, pushed to a temp bare remote. */
function project(root: string): { dir: string; sha: string } {
  const dir = join(root, "work");
  const remote = join(root, "origin.git");
  git(root, "init", "-q", "--bare", "-b", "main", remote);
  git(root, "init", "-q", "-b", "main", dir);
  git(dir, "config", "user.email", "t@chant.dev");
  git(dir, "config", "user.name", "T");
  writeFileSync(join(dir, "chant.config.ts"), `export default { environments: ["dev", "prod"], release: { green: "chant" } };\n`);
  writeFileSync(join(dir, "api.component.ts"), `export const api = { name: "api", dependsOn: [], deploy: [{ phase: "Apply", steps: [{ kind: "cfn-deploy", template: "dist/api.template.json" }] }] };\n`);
  writeFileSync(join(dir, ".gitignore"), "dist/\n");
  git(dir, "add", ".");
  git(dir, "commit", "-q", "-m", "init");
  git(dir, "remote", "add", "origin", remote);
  git(dir, "push", "-q", "origin", "main");
  git(dir, "fetch", "-q", "origin");
  const sha = git(dir, "rev-parse", "HEAD");
  git(dir, "tag", `ci/green/${sha}`);
  return { dir, sha };
}

describe("--dry-run with --yes (#5240)", () => {
  test(
    "release cut, publish, deprecate, yank, restore and compose stay dry runs",
    () => {
      const root = mkdtempSync(join(tmpdir(), "chant-release-dry-run-wins-"));
      try {
        const { dir } = project(root);

        // cut: nothing is recorded or tagged.
        const before = refs(dir);
        const cut = chant(dir, ["release", "cut", "v1", "--build", BUILD, "--dry-run", "--yes", "--json"]);
        expect(cut.code, cut.stderr).toBe(0);
        expect(JSON.parse(cut.stdout)).toMatchObject({ dryRun: true });
        expect(refs(dir)).toBe(before);

        // The real cut the other commands act on.
        const real = chant(dir, ["release", "cut", "v1", "--build", BUILD, "--yes"]);
        expect(real.code, real.stderr).toBe(0);
        const cutState = refs(dir);

        const dry = (verb: string, state: string) => {
          const r = chant(dir, ["release", verb, "v1", "--dry-run", "--yes", "--json"]);
          expect(r.code, `${verb}: ${r.stderr}`).toBe(0);
          expect(JSON.parse(r.stdout), verb).toMatchObject({ dryRun: true });
          expect(refs(dir), verb).toBe(state);
        };
        for (const verb of ["publish", "deprecate", "yank"]) dry(verb, cutState);

        // restore needs a release that was yanked.
        const yank = chant(dir, ["release", "yank", "v1", "--yes"]);
        expect(yank.code, yank.stderr).toBe(0);
        const afterYank = refs(dir);
        dry("restore", afterYank);

        // compose: no branch is moved or pushed.
        const compose = chant(dir, ["release", "compose", "hotfix", "--work", "fix-1", "--dry-run", "--yes", "--json"]);
        expect(refs(dir)).toBe(afterYank);
        if (compose.code === 0) expect(JSON.parse(compose.stdout)).toMatchObject({ dryRun: true });
        else expect(compose.stdout + compose.stderr).not.toMatch(/Composed/);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
    300_000,
  );

  test("release init writes no config and no workflow", () => {
    const root = mkdtempSync(join(tmpdir(), "chant-release-init-dry-run-wins-"));
    try {
      const dir = join(root, "work");
      git(root, "init", "-q", "-b", "main", dir);
      git(dir, "config", "user.email", "t@chant.dev");
      git(dir, "config", "user.name", "T");
      writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "demo", version: "1.0.0" }));
      git(dir, "add", ".");
      git(dir, "commit", "-q", "-m", "package");
      const r = chant(dir, ["release", "init", "--dry-run", "--yes", "--json"]);
      expect(git(dir, "status", "--porcelain")).toBe("");
      expect(existsSync(join(dir, ".github", "workflows"))).toBe(false);
      expect(r.stdout + r.stderr).not.toMatch(/"dryRun": false/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 120_000);
});
