/**
 * #4662 — green lanes: named subsets of ci.green's phases, each tagged
 * ci/green-<lane>/<sha> by the same tick from the same runs, and read back
 * by `ci last-green --lane` and `ci base --lane`.
 */

import { execFileSync } from "node:child_process";
import { afterAll, describe, expect, test } from "vitest";
import { cleanScratch, declaration, git, scratchDir, writeFiles } from "./__fixtures__/contract-repo";
import { ciBase, ciTick, formatTick, lastGreen } from "./ci-green";
import type { CheckRun, CiForge } from "./ci-green-forge";
import { parseDeclaration } from "./declaration";

afterAll(cleanScratch);

const NOW = new Date("2026-10-20T12:00:00Z");
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3_600_000).toISOString();

const GREEN = {
  branch: "main",
  phases: { lint: ["lint"], test: ["test"], windows: ["windows"] },
  require: ["lint", "test", "windows"],
  lanes: { server: { require: ["lint", "test"] } },
};

function commitAt(root: string, hours: number, file: string): string {
  writeFiles(root, { [file]: `${file} ${hours}\n` });
  const env = { ...process.env, GIT_AUTHOR_DATE: hoursAgo(hours), GIT_COMMITTER_DATE: hoursAgo(hours) };
  const g = (...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", ...args], { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] });
  g("add", "-A");
  g("commit", "-q", "-m", file);
  return git(root, "rev-parse", "HEAD");
}

function workspace(green: unknown = GREEN): { root: string; origin: string } {
  const origin = scratchDir("chant-lanes-origin-");
  git(origin, "init", "-q", "--bare");
  const root = scratchDir("chant-lanes-work-");
  git(root, "init", "-q");
  git(root, "symbolic-ref", "HEAD", "refs/heads/main");
  writeFiles(root, { "chant.workspace.json": declaration([{ name: "app", dir: "app", kind: "other", because: "the app" }], { ci: { green } }), "app/a.txt": "a\n" });
  git(root, "remote", "add", "origin", origin);
  return { root, origin };
}

let id = 1;
const run = (name: string, conclusion: string): CheckRun => ({ id: id++, name, status: "completed", conclusion, completedAt: null, url: null });
const forgeOf = (runs: Map<string, CheckRun[]>): CiForge => ({ kind: "github", checkRuns: async (sha) => runs.get(sha) ?? [] });
const remoteTags = (origin: string) => git(origin, "for-each-ref", "--format=%(refname:lstrip=2)", "refs/tags/").split("\n").filter(Boolean).sort();

describe("green lanes (#4662)", () => {
  test("a commit that passes a lane's phases and fails another gets the lane's tag and no ci/green", async () => {
    const { root, origin } = workspace();
    const a = commitAt(root, 3, "app/a.txt");
    const b = commitAt(root, 2, "app/b.txt");
    git(root, "push", "-q", "origin", "main");
    const runs = new Map([
      [a, [run("lint", "success"), run("test", "success"), run("windows", "success")]],
      [b, [run("lint", "success"), run("test", "success"), run("windows", "failure")]],
    ]);

    const tick = await ciTick({ cwd: root, forge: forgeOf(runs), now: NOW });
    expect(tick.made.sort()).toEqual([`ci/green-server/${a}`, `ci/green-server/${b}`, `ci/green/${a}`].sort());
    expect(remoteTags(origin)).toEqual([`ci/green-server/${a}`, `ci/green-server/${b}`, `ci/green/${a}`].sort());
    expect(formatTick(tick)).toContain(`${b.slice(0, 12)}  lane server: made ci/green-server`);
    const annotation = git(root, "tag", "-l", "--format=%(contents)", `ci/green-server/${b}`);
    expect(annotation.split("\n")[0]).toBe("ci: every phase of lane server passed (lint, test)");
    expect(JSON.parse(annotation.slice(annotation.indexOf("{")))).toMatchObject({ tag: "green", lane: "server", commit: b });

    // The lane's newest green commit is b, the branch's is a.
    expect(lastGreen({ cwd: root, lane: "server" })).toMatchObject({ commit: { sha: b, tag: `ci/green-server/${b}` } });
    expect(lastGreen({ cwd: root })).toMatchObject({ commit: { sha: a, tag: `ci/green/${a}` } });

    // A second tick makes nothing again.
    expect((await ciTick({ cwd: root, forge: forgeOf(runs), now: NOW })).made).toEqual([]);
  });

  test("a lane-green commit that later fails the lane's phases gets the lane's revoked tag", async () => {
    const { root, origin } = workspace();
    const a = commitAt(root, 2, "app/a.txt");
    git(root, "push", "-q", "origin", "main");
    const runs = new Map([[a, [run("lint", "success"), run("test", "success"), run("windows", "failure")]]]);
    await ciTick({ cwd: root, forge: forgeOf(runs), now: NOW });
    runs.set(a, [run("lint", "success"), run("test", "failure"), run("windows", "failure")]);
    const tick = await ciTick({ cwd: root, forge: forgeOf(runs), now: NOW });
    expect(tick.made).toEqual([`ci/revoked-server/${a}`]);
    expect(remoteTags(origin)).toContain(`ci/revoked-server/${a}`);
    expect(lastGreen({ cwd: root, lane: "server" })).toMatchObject({ commit: null });
  });

  test("ci base --lane checks the lane's phases and falls back to the lane's tags", async () => {
    const { root } = workspace();
    const a = commitAt(root, 3, "app/a.txt");
    git(root, "push", "-q", "origin", "main");
    await ciTick({ cwd: root, forge: forgeOf(new Map([[a, [run("lint", "success"), run("test", "success"), run("windows", "failure")]]])), now: NOW });
    const docs = commitAt(root, 2, "docs/readme.md");
    // a's record passed the lane's phases; it failed windows, which every required phase includes.
    expect(ciBase({ cwd: root, from: docs, lane: "server" })).toMatchObject({ commit: { sha: a, via: "record", tag: `ci/green-server/${a}` } });
    expect(ciBase({ cwd: root, from: docs })).toMatchObject({ commit: null });
    expect(() => ciBase({ cwd: root, from: docs, lane: "server", phase: "lint" })).toThrow(/give one/);
  });

  test("an unknown lane is declaration-invalid, and a lane must name declared phases", () => {
    const { root } = workspace();
    commitAt(root, 2, "app/a.txt");
    expect(lastGreen({ cwd: root, lane: "app" })).toMatchObject({ error: { code: "declaration-invalid", message: expect.stringContaining('no lane "app"; it declares server') } });
    const bad = JSON.stringify({ name: "w", schema: 1, members: [], ci: { green: { ...GREEN, lanes: { server: { require: ["lint", "deploy"] } } } } });
    expect(() => parseDeclaration(bad, "chant.workspace.json")).toThrow(/ci\.green\.lanes\.server\.require names the phase "deploy"/);
    const named = JSON.stringify({ name: "w", schema: 1, members: [], ci: { green: { ...GREEN, lanes: { Server: { require: ["lint"] } } } } });
    expect(() => parseDeclaration(named, "chant.workspace.json")).toThrow();
  });

  test("a declaration with no lanes ticks as before", async () => {
    const { root } = workspace({ ...GREEN, lanes: undefined });
    const a = commitAt(root, 2, "app/a.txt");
    git(root, "push", "-q", "origin", "main");
    const tick = await ciTick({ cwd: root, forge: forgeOf(new Map([[a, [run("lint", "success"), run("test", "success"), run("windows", "success")]]])), now: NOW });
    expect(tick.made).toEqual([`ci/green/${a}`]);
    expect(tick.lanes).toBeUndefined();
  });
});
