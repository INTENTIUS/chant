/**
 * #2816 — a release tags the newest green commit on main, not HEAD, and
 * merges the bump back into main.
 *
 * These run release-preflight.sh and release-lib.sh against a throwaway repo
 * with a fake `gh` that reports run states, the way the issue asked the
 * change to be checked.
 */

import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const scripts = import.meta.dirname;
const PREFLIGHT = join(scripts, "release-preflight.sh");
const LIB = join(scripts, "release-lib.sh");

type Run = { headSha: string; status: string; conclusion: string; url: string };

let dir: string;
let work: string;
let env: NodeJS.ProcessEnv;

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, env, encoding: "utf8" }).trim();
}

function commit(message: string, files: Record<string, string>): string {
  for (const [path, body] of Object.entries(files)) writeFileSync(join(work, path), body);
  git(work, "add", "-A");
  git(work, "commit", "-q", "-m", message);
  return git(work, "rev-parse", "HEAD");
}

function setRuns(runs: Run[]): void {
  writeFileSync(join(dir, "runs.json"), JSON.stringify(runs));
}

function run(cmd: string, args: string[], extra: NodeJS.ProcessEnv = {}) {
  const r = spawnSync(cmd, args, { cwd: work, env: { ...env, ...extra }, encoding: "utf8" });
  return { code: r.status, stdout: r.stdout.trim(), stderr: r.stderr };
}

const pkg = (version: string, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ name: "@intentius/chant", version, ...extra }, null, 2) + "\n";
const lock = (version: string) =>
  JSON.stringify({ name: "root", packages: { "packages/core": { version } } }, null, 2) + "\n";

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "chant-release-"));
  const bin = join(dir, "bin");
  mkdirSync(bin);
  writeFileSync(
    join(bin, "gh"),
    `#!/usr/bin/env bash\nif [ "$1 $2" = "run list" ]; then cat "${join(dir, "runs.json")}"; exit 0; fi\nexit 1\n`,
  );
  chmodSync(join(bin, "gh"), 0o755);
  env = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH}`,
    GIT_AUTHOR_NAME: "t",
    GIT_AUTHOR_EMAIL: "t@t",
    GIT_COMMITTER_NAME: "t",
    GIT_COMMITTER_EMAIL: "t@t",
    GIT_CONFIG_GLOBAL: "/dev/null",
    CHANT_RELEASE_SKIP_PREFLIGHT: "",
  };
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", join(dir, "origin.git")], { env });
  execFileSync("git", ["clone", "-q", join(dir, "origin.git"), join(dir, "work")], { env });
  work = join(dir, "work");
  git(work, "checkout", "-q", "-b", "main");
  mkdirSync(join(work, "packages", "core"), { recursive: true });
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("release-preflight.sh picks the commit (#2816)", () => {
  let a: string, b: string, c: string;
  beforeEach(() => {
    a = commit("A", { "a.txt": "a" });
    b = commit("B", { "b.txt": "b" });
    c = commit("C", { "c.txt": "c" });
    git(work, "push", "-q", "origin", "main");
  });

  it("releases the newest green commit when HEAD is red or pending, and says which", () => {
    setRuns([
      { headSha: c, status: "in_progress", conclusion: "", url: "u/c" },
      { headSha: b, status: "completed", conclusion: "failure", url: "u/b" },
      { headSha: a, status: "completed", conclusion: "success", url: "u/a" },
    ]);
    const r = run("bash", [PREFLIGHT]);
    expect(r.code).toBe(0);
    expect(r.stdout).toBe(a);
    expect(r.stderr).toMatch(/newest green commit on main/);
    expect(r.stderr).toMatch(/chant in_progress/);
    expect(r.stderr).toMatch(/chant failure/);
  });

  it("takes a commit's latest run, so a green re-run counts and a newer red one does not", () => {
    setRuns([
      { headSha: c, status: "completed", conclusion: "failure", url: "u/c2" },
      { headSha: c, status: "completed", conclusion: "success", url: "u/c1" },
      { headSha: b, status: "completed", conclusion: "success", url: "u/b" },
    ]);
    expect(run("bash", [PREFLIGHT]).stdout).toBe(b);
  });

  it("checks a named commit instead of HEAD", () => {
    setRuns([
      { headSha: c, status: "completed", conclusion: "success", url: "u/c" },
      { headSha: b, status: "completed", conclusion: "failure", url: "u/b" },
    ]);
    const red = run("bash", [PREFLIGHT, b]);
    expect(red.code).toBe(1);
    expect(red.stderr).toMatch(/concluded "failure"/);
    expect(run("bash", [PREFLIGHT, b.slice(0, 9)]).code).toBe(1);
    expect(run("bash", [PREFLIGHT, c]).stdout).toBe(c);
  });

  it("refuses a commit that is not on main, even with the opt-out", () => {
    git(work, "checkout", "-q", "--detach");
    const off = commit("off", { "off.txt": "x" });
    setRuns([{ headSha: off, status: "completed", conclusion: "success", url: "u/off" }]);
    const r = run("bash", [PREFLIGHT, off], { CHANT_RELEASE_SKIP_PREFLIGHT: "1" });
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/not on origin\/main/);
  });

  it("fails when nothing on main is green", () => {
    setRuns([{ headSha: c, status: "completed", conclusion: "cancelled", url: "u/c" }]);
    const r = run("bash", [PREFLIGHT]);
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/no green chant run/);
  });
});

describe("release-lib.sh (#2816)", () => {
  const lib = (body: string, extra: NodeJS.ProcessEnv = {}) =>
    run("bash", ["-c", `set -euo pipefail; source "${LIB}"; ${body}`], extra);

  it("parses a bump, a commit and --dry-run in any order", () => {
    const r = lib('release_args --dry-run abc123 minor; echo "$RELEASE_BUMP $RELEASE_COMMIT $RELEASE_DRY_RUN"');
    expect(r.stdout).toBe("minor abc123 1");
    expect(lib('release_args; echo "$RELEASE_BUMP [$RELEASE_COMMIT] $RELEASE_DRY_RUN"').stdout).toBe("patch [] 0");
    expect(lib("release_args --force").code).toBe(1);
  });

  it("bumps and floors versions", () => {
    expect(lib("release_next 0.91.3 minor").stdout).toBe("0.92.0");
    expect(lib("release_next 0.91.3 patch").stdout).toBe("0.91.4");
    expect(lib("release_max 0.9.0 0.10.0 '' 0.2.1").stdout).toBe("0.10.0");
  });

  it("merges the tagged bump into a main that moved, keeping main's edits", () => {
    const green = commit("green", {
      "packages/core/package.json": pkg("0.91.0"),
      "package-lock.json": lock("0.91.0"),
    });
    // main moves on: an edit to the same package.json, and another file.
    commit("later", {
      "packages/core/package.json": pkg("0.91.0", { description: "edited after green" }),
      "later.txt": "later",
    });
    git(work, "push", "-q", "origin", "main");
    const body = `
      bump_files=(packages/core/package.json)
      next=0.92.0
      apply_bump() {
        jq --arg v "$next" '.version = $v' packages/core/package.json > t && mv t packages/core/package.json
        jq --arg v "$next" '.packages["packages/core"].version = $v' package-lock.json > t && mv t package-lock.json
      }
      release_open ${green}
      apply_bump
      git add packages/core/package.json package-lock.json
      git commit -q -m chant-v0.92.0
      git tag chant-v0.92.0
      release_ship chant-v0.92.0 "Merge chant-v0.92.0 into main"
    `;
    const r = lib(body);
    expect(r.stderr).toBe("");
    expect(r.code).toBe(0);
    git(work, "fetch", "-q", "--tags", "origin");
    // The tag is the bump on top of the green commit, and main contains it.
    expect(git(work, "rev-parse", "chant-v0.92.0^")).toBe(green);
    expect(git(work, "merge-base", "--is-ancestor", "chant-v0.92.0", "origin/main")).toBe("");
    const core = JSON.parse(git(work, "show", "origin/main:packages/core/package.json"));
    expect(core).toMatchObject({ version: "0.92.0", description: "edited after green" });
    expect(JSON.parse(git(work, "show", "origin/main:package-lock.json")).packages["packages/core"].version).toBe(
      "0.92.0",
    );
    expect(git(work, "show", "origin/main:later.txt")).toBe("later");
    // Nothing was rewritten: the pre-release main is still an ancestor.
    expect(git(work, "rev-parse", "origin/main^1")).toBe(git(work, "rev-parse", "main"));
    // No worktree is left behind.
    expect(git(work, "worktree", "list").split("\n")).toHaveLength(1);
  });

  it("fast-forwards main when the green commit is main's HEAD", () => {
    const green = commit("green", {
      "packages/core/package.json": pkg("0.91.0"),
      "package-lock.json": lock("0.91.0"),
    });
    git(work, "push", "-q", "origin", "main");
    const r = lib(`
      bump_files=(packages/core/package.json)
      apply_bump() { :; }
      release_open ${green}
      jq '.version = "0.91.1"' packages/core/package.json > t && mv t packages/core/package.json
      git commit -q -am chant-v0.91.1
      git tag chant-v0.91.1
      release_ship chant-v0.91.1 "Merge chant-v0.91.1 into main"
    `);
    expect(r.code).toBe(0);
    git(work, "fetch", "-q", "origin");
    expect(git(work, "rev-parse", "origin/main")).toBe(git(work, "rev-parse", "chant-v0.91.1"));
  });
});
