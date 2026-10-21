/**
 * #4169 — the tick against a real remote with a fake forge, for a phase that
 * builds only the newest commit: the records it writes on chant/lifecycle,
 * the build requests it pushes and starts, the retries it asks for, and what
 * `ci list`, `ci last-green` and `ci run --at` read and do.
 */

import { execFileSync } from "node:child_process";
import { afterAll, describe, expect, test } from "vitest";
import { cleanScratch, declaration, git, scratchDir, writeFiles } from "./__fixtures__/contract-repo";
import { ciList, ciTick, lastGreen, requestBuild } from "./ci-green";
import type { CheckRun, CiForge } from "./ci-green-forge";
import { readBuildRequests, readCiRecord } from "./ci-builds";

afterAll(cleanScratch);

const NOW = new Date("2026-10-20T12:00:00Z");
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3_600_000).toISOString();

const GREEN = {
  branch: "main",
  phases: { check: { runs: ["check"], build: "every" }, suites: { runs: ["suites"], build: "newest" } },
  require: ["check", "suites"],
};

const SUITES_WORKFLOW = "name: release-suites\non:\n  push:\n    branches: [main]\n  workflow_dispatch: {}\njobs:\n  suites:\n    runs-on: ubuntu-latest\n    steps:\n      - run: true\n";

function gitAt(cwd: string, date: string, ...args: string[]): string {
  return execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", ...args], {
    cwd,
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date },
  }).trim();
}

function commitAt(root: string, hours: number, file: string): string {
  writeFiles(root, { [file]: `${file} ${hours}\n` });
  gitAt(root, hoursAgo(hours), "add", "-A");
  gitAt(root, hoursAgo(hours), "commit", "-q", "-m", file);
  return git(root, "rev-parse", "HEAD");
}

function workspace(): { root: string; origin: string } {
  const origin = scratchDir("chant-builds-origin-");
  git(origin, "init", "-q", "--bare");
  const root = scratchDir("chant-builds-work-");
  git(root, "init", "-q");
  git(root, "symbolic-ref", "HEAD", "refs/heads/main");
  writeFiles(root, {
    "chant.workspace.json": declaration([{ name: "app", dir: "app", kind: "other", because: "the app" }], { ci: { green: GREEN } }),
    "app/a.txt": "a\n",
    ".github/workflows/release-suites.yml": SUITES_WORKFLOW,
  });
  git(root, "remote", "add", "origin", origin);
  return { root, origin };
}

let id = 1;
const run = (name: string, conclusion: string | null, status = "completed"): CheckRun => ({ id: id++, name, status, conclusion: status === "completed" ? conclusion : null, completedAt: null, url: null });

/** A forge whose runs the test sets per commit, recording the re-runs and the workflows started. */
function fakeForge(runs: Map<string, CheckRun[]>): CiForge & { reruns: number[]; dispatched: string[] } {
  const reruns: number[] = [];
  const dispatched: string[] = [];
  return {
    kind: "github",
    reruns,
    dispatched,
    checkRuns: async (sha) => runs.get(sha) ?? [],
    rerun: async (r) => void reruns.push(r.id),
    dispatch: async (w, ref) => void dispatched.push(`${w}@${ref}`),
  };
}

const remoteRecord = (origin: string, sha: string) => JSON.parse(git(origin, "show", `refs/heads/chant/lifecycle:_ci/${sha}.json`));
const remoteTags = (origin: string) => git(origin, "for-each-ref", "--format=%(refname:lstrip=2)", "refs/tags/").split("\n").filter(Boolean).sort();

describe("the tick for a newest phase (#4169)", () => {
  test("records each commit, and asks for a bisect step at a ci/build tag and starts the workflow there once", async () => {
    const { root, origin } = workspace();
    const base = commitAt(root, 6, "app/base.txt");
    const a = commitAt(root, 5, "app/a.txt");
    const b = commitAt(root, 4, "app/b.txt");
    const c = commitAt(root, 3, "app/c.txt");
    git(root, "push", "-q", "origin", "main");
    const runs = new Map<string, CheckRun[]>([
      [base, [run("check", "success"), run("suites", "success")]],
      [a, [run("check", "success")]],
      [b, [run("check", "success")]],
      [c, [run("check", "success"), run("suites", "failure"), run("suites", "failure")]],
    ]);
    const forge = fakeForge(runs);

    const first = await ciTick({ cwd: root, forge, now: NOW });
    expect(first.made).toEqual([`ci/green/${base}`]);
    // The newest red asks for the commit just below it.
    expect(first.requested.map((r) => [r.commit, r.reason])).toEqual([[b, "bisect"]]);
    expect(remoteTags(origin)).toEqual([`ci/build/${b}`, `ci/green/${base}`].sort());
    expect(forge.dispatched).toEqual([`release-suites.yml@ci/build/${b}`]);
    expect(remoteRecord(origin, a)).toMatchObject({ state: "unbuilt", phases: { suites: { verdict: "unbuilt", reason: "superseded", coveredBy: c } } });
    expect(remoteRecord(origin, b)).toMatchObject({ state: "pending", request: { tag: `ci/build/${b}`, reason: "bisect", dispatched: true }, phases: { suites: { reason: "requested" } } });
    expect(remoteRecord(origin, c)).toMatchObject({ state: "red", failure: { phase: "suites" } });

    // A second tick asks for nothing more and starts nothing again while b's build waits.
    const second = await ciTick({ cwd: root, forge, now: NOW });
    expect(second.requested).toEqual([]);
    expect(forge.dispatched).toHaveLength(1);

    // ci list and ci last-green read the records. (The walk to the culprit is ci-builds.e2e.test.ts.)
    const list = await ciList({ cwd: root, now: NOW });
    if ("error" in list) throw new Error(list.error.message);
    expect(list.commits.find((x) => x.sha === a)!.record).toEqual({ state: "unbuilt", reason: "superseded", coveredBy: c });
    const last = lastGreen({ cwd: root });
    if ("error" in last) throw new Error(last.error.message);
    expect(last.commit!.sha).toBe(base);
    expect(last.newer.map((n) => [n.sha, n.record?.state])).toEqual([
      [c, "red"],
      [b, "pending"],
      [a, "unbuilt"],
    ]);
  });

  test("runs a failed job again once before the commit counts red", async () => {
    const { root, origin } = workspace();
    const a = commitAt(root, 2, "app/a.txt");
    git(root, "push", "-q", "origin", "main");
    const failed = run("check", "failure");
    const runs = new Map([[a, [failed, run("suites", "success")]]]);
    const forge = fakeForge(runs);
    const tick = await ciTick({ cwd: root, forge, now: NOW });
    expect(tick.retried).toEqual([{ sha: a, run: "check" }]);
    expect(forge.reruns).toEqual([failed.id]);
    expect(remoteRecord(origin, a)).toMatchObject({ state: "pending", retried: { check: { run: failed.id } } });
    // Asked once: the next tick waits for the attempt and does not ask again.
    await ciTick({ cwd: root, forge, now: NOW });
    expect(forge.reruns).toEqual([failed.id]);
    runs.set(a, [failed, run("check", "success"), run("suites", "success")]);
    expect((await ciTick({ cwd: root, forge, now: NOW })).made).toEqual([`ci/green/${a}`]);
  });

  test("a dry run writes no record and pushes no request", async () => {
    const { root, origin } = workspace();
    const base = commitAt(root, 4, "app/base.txt");
    const a = commitAt(root, 3, "app/a.txt");
    const b = commitAt(root, 2, "app/b.txt");
    git(root, "push", "-q", "origin", "main");
    const runs = new Map([
      [base, [run("check", "success"), run("suites", "success")]],
      [a, [run("check", "success")]],
      [b, [run("check", "success"), run("suites", "failure"), run("suites", "failure")]],
    ]);
    const tick = await ciTick({ cwd: root, forge: fakeForge(runs), now: NOW, dryRun: true });
    expect(tick.requested.map((r) => r.commit)).toEqual([a]);
    expect(tick.recorded).toEqual([]);
    expect(remoteTags(origin)).toEqual([]);
    expect(() => git(origin, "rev-parse", "--verify", "refs/heads/chant/lifecycle")).toThrow();
  });
});

describe("the tick for a missing every phase (#4216)", () => {
  const CHECK_WORKFLOW = "name: ci\non:\n  push:\n    branches: [main]\n  workflow_dispatch: {}\njobs:\n  check:\n    runs-on: ubuntu-latest\n    steps:\n      - run: true\n";

  test("a commit the forge never ran check on gets one request, started at its ci/build tag, and the record keeps it", async () => {
    const { root, origin } = workspace();
    writeFiles(root, { ".github/workflows/ci.yml": CHECK_WORKFLOW });
    const a = commitAt(root, 2, "app/a.txt");
    git(root, "push", "-q", "origin", "main");
    // GitHub skipped a's push run of ci.yml; release-suites ran.
    const runs = new Map([[a, [run("suites", "success")]]]);
    const forge = fakeForge(runs);
    const tick = await ciTick({ cwd: root, forge, now: NOW });
    expect(tick.requested.map((r) => [r.commit, r.phases, r.reason])).toEqual([[a, ["check"], "missing"]]);
    expect(forge.dispatched).toEqual([`ci.yml@ci/build/${a}`]);
    expect(remoteTags(origin)).toEqual([`ci/build/${a}`]);
    expect(remoteRecord(origin, a)).toMatchObject({ state: "pending", missing: { phases: ["check"] }, request: { reason: "missing", dispatched: true }, phases: { check: { reason: "requested" } } });

    // The started run passes: the commit goes green and the request is done.
    runs.set(a, [run("suites", "success"), run("check", "success")]);
    const second = await ciTick({ cwd: root, forge, now: NOW });
    expect(second.made).toEqual([`ci/green/${a}`]);
    expect(second.requested).toEqual([]);
    expect(forge.dispatched).toHaveLength(1);
  });
});

describe("chant ci run --at (#4169)", () => {
  test("pushes a request for every required phase and starts the workflows holding them", async () => {
    const { root, origin } = workspace();
    const a = commitAt(root, 2, "app/a.txt");
    commitAt(root, 1, "app/b.txt");
    git(root, "push", "-q", "origin", "main");
    const forge = fakeForge(new Map());
    const r = await requestBuild({ cwd: root, at: a, forge, now: NOW });
    expect(r.request).toMatchObject({ commit: a, phases: ["check", "suites"], reason: "requested", tag: `ci/build/${a}` });
    expect(r.existed).toBe(false);
    expect(r.dispatched).toEqual(["release-suites.yml"]);
    expect(remoteTags(origin)).toEqual([`ci/build/${a}`]);
    expect(readBuildRequests(root).get(a)).toMatchObject({ reason: "requested" });
    expect((await requestBuild({ cwd: root, at: a, now: NOW })).existed).toBe(true);
    await expect(requestBuild({ cwd: root, at: "nope", now: NOW })).rejects.toThrow(/names no commit/);
    // The tick takes the run already going at the commit as started, and records the request.
    await ciTick({ cwd: root, forge: fakeForge(new Map([[a, [run("check", "success"), run("suites", null, "in_progress")]]])), now: NOW });
    expect(readCiRecord(root, a)).toMatchObject({ state: "pending", request: { reason: "requested", dispatched: true } });
  });
});
