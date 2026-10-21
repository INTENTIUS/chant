/**
 * #4169 — which commits get built: supersession, retries, requests and
 * bisection over judged commits, and the records each commit gets.
 */

import { describe, expect, test } from "vitest";
import { agedOut, BUILD_REQUEST_TTL_MS, planBuilds, recordOf, RETRY_TTL_MS, sameRecord, type BuildRequest, type CiRecord } from "./ci-builds";
import { evaluateCommit, type TickCommit } from "./ci-green";
import type { CheckRun } from "./ci-green-forge";
import type { CiGreen } from "./declaration";

const NOW = new Date("2026-10-20T12:00:00Z");
const ago = (ms: number) => new Date(NOW.getTime() - ms).toISOString().replace(/\.\d{3}Z$/, "Z");

const GREEN: CiGreen = {
  branch: "main",
  window: "24h",
  phases: [
    { name: "check", runs: ["check"], skipped: "fail", build: "every", pointer: "/ci/green/phases/check" },
    { name: "suites", runs: ["suites"], skipped: "fail", build: "newest", pointer: "/ci/green/phases/suites" },
  ],
  require: ["check", "suites"],
  signedSince: null,
  source: "checks",
  pointer: "/ci/green",
};

let nextId = 1;
const run = (name: string, conclusion: string | null, status = "completed"): CheckRun => ({ id: nextId++, name, status, conclusion: status === "completed" ? conclusion : null, completedAt: null, url: null });
const sha = (n: number) => String(n).padStart(40, "0");

/** Commits newest first, each with its runs, judged as the tick judges them. */
function judged(runsPerCommit: CheckRun[][], before: TickCommit["before"][] = []): { commits: TickCommit[]; runs: Map<string, CheckRun[]> } {
  const runs = new Map<string, CheckRun[]>();
  const commits = runsPerCommit.map((r, i) => {
    const s = sha(runsPerCommit.length - i);
    runs.set(s, r);
    return { sha: s, committed: NOW.toISOString(), before: before[i] ?? "none", verdict: evaluateCommit(GREEN, r), made: null } as TickCommit;
  });
  return { commits, runs };
}

const plan = (commits: TickCommit[], runs: Map<string, CheckRun[]>, extra: Partial<Parameters<typeof planBuilds>[0]> = {}) =>
  planBuilds({ green: GREEN, commits, runs, requests: new Map(), records: new Map(), now: NOW, retryVia: null, ...extra });

const suites = (c: TickCommit) => c.verdict!.phases.find((p) => p.phase === "suites")!;

describe("supersession (#4169)", () => {
  test("a newest phase with no run below a commit that has one is unbuilt, covered by it; the newest commit stays pending", () => {
    const { commits, runs } = judged([[run("check", "success")], [run("check", "success"), run("suites", "success")], [run("check", "success")]]);
    plan(commits, runs);
    expect(commits.map((c) => c.verdict!.verdict)).toEqual(["pending", "pass", "unbuilt"]);
    expect(suites(commits[2])).toMatchObject({ verdict: "unbuilt", reason: "superseded", coveredBy: commits[1].sha });
    expect(suites(commits[0])).toMatchObject({ verdict: "pending" });
  });

  test("an every phase is never superseded, and a cancelled run is unbuilt under either", () => {
    const { commits, runs } = judged([[run("check", "success"), run("suites", "success")], [run("suites", "success")], [run("check", "cancelled"), run("suites", "success")]]);
    plan(commits, runs);
    expect(commits.map((c) => c.verdict!.verdict)).toEqual(["pass", "pending", "unbuilt"]);
    expect(commits[2].verdict!.phases[0]).toMatchObject({ phase: "check", verdict: "unbuilt", reason: "cancelled" });
  });
});

describe("bisect (#4169)", () => {
  const green = () => [run("check", "success"), run("suites", "success")];
  const red = () => [run("check", "success"), run("suites", "failure")];
  const none = () => [run("check", "success")];

  test("a red newest commit asks for the one just below it when four or fewer are unbuilt", () => {
    const { commits, runs } = judged([red(), none(), none(), green()]);
    const p = plan(commits, runs);
    expect(p.requests).toEqual([expect.objectContaining({ commit: commits[1].sha, phases: ["suites"], reason: "bisect", tag: `ci/build/${commits[1].sha}` })]);
    expect(suites(commits[1])).toMatchObject({ verdict: "pending", reason: "requested" });
  });

  test("halves the range above four, and asks for nothing while a request in it waits", () => {
    const { commits, runs } = judged([red(), none(), none(), none(), none(), none(), none(), green()]);
    const p = plan(commits, runs);
    expect(p.requests.map((r) => r.commit)).toEqual([commits[4].sha]);
    const waiting: BuildRequest = { ...p.requests[0], at: ago(60_000) };
    const again = judged([red(), none(), none(), none(), none(), none(), none(), green()]);
    expect(plan(again.commits, again.runs, { requests: new Map([[waiting.commit, waiting]]) }).requests).toEqual([]);
  });

  test("names the culprit on it and every commit after it once the red sits on a green", () => {
    const { commits, runs } = judged([red(), none(), red(), green()]);
    // The commit below the newest red is unbuilt between two reds: the culprit is at or below the older red.
    plan(commits, runs);
    expect(commits.map((c) => suites(c).culprit)).toEqual([commits[2].sha, commits[2].sha, commits[2].sha, undefined]);
  });

  test("names no culprit without a green below, and an every phase gets one too", () => {
    const noGreen = judged([red(), red()]);
    plan(noGreen.commits, noGreen.runs);
    expect(noGreen.commits.map((c) => suites(c).culprit)).toEqual([undefined, undefined]);
    const every = judged([[run("check", "failure")], [run("check", "failure")], [run("check", "success")]]);
    plan(every.commits, every.runs);
    expect(every.commits.map((c) => c.verdict!.phases[0].culprit)).toEqual([every.commits[1].sha, every.commits[1].sha, undefined]);
  });
});

describe("requests (#4169)", () => {
  const req = (commit: string, at: string): BuildRequest => ({ schema: 1, tag: `ci/build/${commit}`, commit, branch: "main", phases: ["suites"], reason: "requested", at });

  test("a request holds its phase pending; once decided, or too old, or out of the window, it is done", () => {
    const { commits, runs } = judged([[run("check", "success"), run("suites", "success")], [run("check", "success")]]);
    const waiting = req(commits[1].sha, ago(60_000));
    const p = plan(commits, runs, { requests: new Map([[waiting.commit, waiting]]) });
    expect(suites(commits[1])).toMatchObject({ verdict: "pending", reason: "requested" });
    expect(p.resolved).toEqual([]);

    const old = judged([[run("check", "success"), run("suites", "success")], [run("check", "success")]]);
    const stale = req(old.commits[1].sha, ago(BUILD_REQUEST_TTL_MS + 1));
    expect(plan(old.commits, old.runs, { requests: new Map([[stale.commit, stale]]) }).resolved).toEqual([stale.tag]);
    expect(suites(old.commits[1])).toMatchObject({ verdict: "unbuilt", reason: "request-unserved" });

    const done = judged([[run("check", "success"), run("suites", "success")]]);
    const served = req(done.commits[0].sha, ago(60_000));
    const gone = req(sha(99), ago(60_000));
    expect(plan(done.commits, done.runs, { requests: new Map([[served.commit, served], [gone.commit, gone]]) }).resolved.sort()).toEqual([served.tag, gone.tag].sort());
  });
});

describe("retry (#4169)", () => {
  test("a failed run with one attempt is run again and holds the commit pending; a second attempt decides", () => {
    const failed = run("check", "failure");
    const { commits, runs } = judged([[failed, run("suites", "success")]]);
    const p = plan(commits, runs, { retryVia: "forge" });
    expect(p.retries).toEqual([{ sha: commits[0].sha, run: failed }]);
    expect(commits[0].verdict!.verdict).toBe("pending");
    expect(commits[0].verdict!.phases[0]).toMatchObject({ verdict: "pending", reason: "retrying" });

    const twice = judged([[failed, run("check", "failure"), run("suites", "success")]]);
    expect(plan(twice.commits, twice.runs, { retryVia: "forge" }).retries).toEqual([]);
    expect(twice.commits[0].verdict!.verdict).toBe("fail");
  });

  test("a retry asked for waits an hour for its attempt, then the failure counts; chant runs ask by request; a green commit is never retried", () => {
    const failed = run("check", "failure");
    const asked = (at: string): CiRecord => ({ schema: 1, commit: sha(1), branch: "main", state: "pending", at, phases: {}, retried: { check: { run: failed.id, at } } });
    const waiting = judged([[failed, run("suites", "success")]]);
    expect(plan(waiting.commits, waiting.runs, { retryVia: "forge", records: new Map([[sha(1), asked(ago(60_000))]]) }).retries).toEqual([]);
    expect(waiting.commits[0].verdict!.verdict).toBe("pending");
    const late = judged([[failed, run("suites", "success")]]);
    plan(late.commits, late.runs, { retryVia: "forge", records: new Map([[sha(1), asked(ago(RETRY_TTL_MS + 1))]]) });
    expect(late.commits[0].verdict!.verdict).toBe("fail");

    const viaRequest = judged([[failed, run("suites", "success")]]);
    expect(plan(viaRequest.commits, viaRequest.runs, { retryVia: "request" }).requests).toEqual([expect.objectContaining({ commit: sha(1), phases: ["check"], reason: "retry" })]);

    const tagged = judged([[failed, run("suites", "success")]], ["green"]);
    expect(plan(tagged.commits, tagged.runs, { retryVia: "forge" }).retries).toEqual([]);
  });
});

describe("records (#4169)", () => {
  test("say green, red, unbuilt or pending with each phase's verdict, reason and covering commit, and skip the time when compared", () => {
    const { commits, runs } = judged([[run("check", "success"), run("suites", "success")], [run("check", "success")]]);
    plan(commits, runs);
    commits[0].made = { tag: `ci/green/${commits[0].sha}`, message: "" };
    const top = recordOf({ green: GREEN, commit: commits[0], retries: [], requests: new Map(), now: NOW });
    expect(top).toMatchObject({ state: "green", commit: commits[0].sha, phases: { check: { verdict: "pass", build: "every" }, suites: { verdict: "pass", build: "newest" } } });
    const below = recordOf({ green: GREEN, commit: commits[1], retries: [], requests: new Map(), now: NOW });
    expect(below).toMatchObject({ state: "unbuilt", phases: { suites: { verdict: "unbuilt", reason: "superseded", coveredBy: commits[0].sha } } });
    expect(sameRecord({ ...below, at: "2020-01-01T00:00:00Z" }, below)).toBe(true);
    expect(sameRecord({ ...below, state: "pending" }, below)).toBe(false);
  });

  test("a pending record that left the window is rewritten unbuilt, aged out", () => {
    const pending: CiRecord = { schema: 1, commit: sha(1), branch: "main", state: "pending", at: ago(1), phases: { suites: { verdict: "pending", build: "newest", runs: [] } } };
    expect(agedOut(pending, NOW)).toMatchObject({ state: "unbuilt", phases: { suites: { verdict: "unbuilt", reason: "aged-out" } } });
  });
});
