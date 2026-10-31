/**
 * #4645 — the tick tells people through ci.green.notify: ci.red when the
 * branch's newest decided commit is red after its retry, ci.culprit when a
 * bisect names the first red commit, ci.green when the branch is green again.
 * Each once, remembered in the commit's _ci record.
 */

import { execFileSync } from "node:child_process";
import { afterAll, describe, expect, test } from "vitest";
import { cleanScratch, declaration, git, scratchDir, writeFiles } from "./__fixtures__/contract-repo";
import { ciTick, formatTick } from "./ci-green";
import type { CheckRun, CiForge } from "./ci-green-forge";
import { readCiRecord } from "./ci-builds";
import type { NotifyConfig, NotifyDelivery, NotifyEvent } from "../notify";

afterAll(cleanScratch);

const NOW = new Date("2026-10-20T12:00:00Z");
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3_600_000).toISOString();
const NOTIFY = { webhook: "HOOK_URL", key: "HOOK_KEY" };
const GREEN = { branch: "main", phases: { lint: ["lint"], test: ["test"] }, require: ["lint", "test"], notify: NOTIFY };

function commitAt(root: string, hours: number, file: string): string {
  writeFiles(root, { [file]: `${file} ${hours}\n` });
  const env = { ...process.env, GIT_AUTHOR_DATE: hoursAgo(hours), GIT_COMMITTER_DATE: hoursAgo(hours) };
  const g = (...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", ...args], { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] });
  g("add", "-A");
  g("commit", "-q", "-m", file);
  return git(root, "rev-parse", "HEAD");
}

function workspace(green: unknown = GREEN): { root: string } {
  const origin = scratchDir("chant-notify-origin-");
  git(origin, "init", "-q", "--bare");
  const root = scratchDir("chant-notify-work-");
  git(root, "init", "-q");
  git(root, "symbolic-ref", "HEAD", "refs/heads/main");
  writeFiles(root, { "chant.workspace.json": declaration([{ name: "app", dir: "app", kind: "other", because: "the app" }], { ci: { green } }), "app/a.txt": "a\n" });
  git(root, "remote", "add", "origin", origin);
  return { root };
}

let id = 1;
const run = (name: string, conclusion: string): CheckRun => ({ id: id++, name, status: "completed", conclusion, completedAt: null, url: `https://ci.example/runs/${id}` });
const pass = () => [run("lint", "success"), run("test", "success")];
const fail = () => [run("lint", "success"), run("test", "failure")];
/** A forge with no re-run: a red commit is red at once, with nothing to retry. */
const forgeOf = (runs: Map<string, CheckRun[]>): CiForge => ({ kind: "github", checkRuns: async (sha) => runs.get(sha) ?? [] });

/** A notify that records each event and answers as `answer` says. */
function sink(answer: (e: NotifyEvent) => NotifyDelivery[] = () => [{ target: "webhook", ok: true, detail: "delivered" }]) {
  const sent: NotifyEvent[] = [];
  const send = async (config: NotifyConfig | undefined, e: NotifyEvent | undefined) => {
    if (!config || !e) return [];
    sent.push(e);
    return answer(e);
  };
  return { sent, send };
}

const tick = (root: string, runs: Map<string, CheckRun[]>, s: ReturnType<typeof sink>, more: { dryRun?: boolean } = {}) =>
  ciTick({ cwd: root, forge: forgeOf(runs), now: NOW, env: { GITHUB_REPOSITORY: "acme/app", GITHUB_RUN_ID: "9" }, sendNotify: s.send, ...more });

describe("the tick's notify events (#4645)", () => {
  test("ci.red once for a red tip", async () => {
    const { root } = workspace();
    const a = commitAt(root, 3, "app/a.txt");
    const b = commitAt(root, 2, "app/b.txt");
    git(root, "push", "-q", "origin", "main");
    const runs = new Map([
      [a, pass()],
      [b, fail()],
    ]);
    const s = sink();

    const first = await tick(root, runs, s);
    expect(s.sent.map((e) => [e.event, e.ci?.commit])).toEqual([["ci.red", b]]);
    const red = s.sent[0]!;
    expect(red).toMatchObject({ source: "chant", project: "acme/app", summary: expect.stringMatching(/^main is red at [0-9a-f]{12}: phase test, test failure$/), ci: { branch: "main", phase: "test", failedRun: { name: "test", conclusion: "failure" } }, run: { commit: b } });
    // The tick's own run link says nothing about the commit, so it isn't in the event.
    expect(red.run?.url).toBeUndefined();
    expect(first.notified).toEqual([{ event: "ci.red", commit: b, sent: true }]);
    expect(formatTick(first)).toContain(`${b.slice(0, 12)}  told ci.red`);
    expect(readCiRecord(root, b)?.notified?.red).toBe(NOW.toISOString().replace(/\.\d{3}Z$/, "Z"));

    // The next tick tells nothing again.
    await tick(root, runs, s);
    expect(s.sent).toHaveLength(1);
  });

  test("ci.green once when the branch is green again, naming the red commit", async () => {
    const { root } = workspace();
    const b = commitAt(root, 2, "app/b.txt");
    git(root, "push", "-q", "origin", "main");
    const runs = new Map([[b, fail()]]);
    const s = sink();
    await tick(root, runs, s);
    // A fix lands and passes.
    const c = commitAt(root, 1, "app/c.txt");
    git(root, "push", "-q", "origin", "main");
    runs.set(c, pass());
    await tick(root, runs, s);
    expect(s.sent.map((e) => [e.event, e.ci?.commit, e.ci?.red])).toEqual([
      ["ci.red", b, undefined],
      ["ci.green", c, b],
    ]);
    expect(readCiRecord(root, b)?.notified).toMatchObject({ green: c });
    await tick(root, runs, s);
    expect(s.sent).toHaveLength(2);
  });

  test("ci.culprit names the first red commit below a red tip, once", async () => {
    const { root } = workspace({ ...GREEN, phases: { lint: ["lint"], test: { runs: ["test"], build: "newest" } } });
    const base = commitAt(root, 4, "app/a.txt");
    const a = commitAt(root, 3, "app/b.txt");
    const b = commitAt(root, 2, "app/c.txt");
    git(root, "push", "-q", "origin", "main");
    // a's test was superseded and never ran; b's failed. The bisect asks for a.
    const runs = new Map([
      [base, pass()],
      [a, [run("lint", "success")]],
      [b, fail()],
    ]);
    const s = sink();
    await tick(root, runs, s);
    expect(s.sent.map((e) => e.event)).toEqual(["ci.red"]);
    // a's build fails too, so a is the culprit.
    runs.set(a, fail());
    await tick(root, runs, s);
    expect(s.sent.map((e) => [e.event, e.ci?.commit, e.ci?.culprit])).toEqual([
      ["ci.red", b, undefined],
      ["ci.culprit", b, a],
    ]);
    await tick(root, runs, s);
    expect(s.sent).toHaveLength(2);
  });

  test("a dry run tells and marks nothing, and a failed delivery is tried again next tick", async () => {
    const { root } = workspace();
    const a = commitAt(root, 2, "app/a.txt");
    git(root, "push", "-q", "origin", "main");
    const runs = new Map([[a, fail()]]);
    const dry = sink();
    const would = await tick(root, runs, dry, { dryRun: true });
    expect(dry.sent).toEqual([]);
    expect(would.notified).toEqual([{ event: "ci.red", commit: a, sent: false }]);

    const down = sink(() => [{ target: "webhook", ok: false, detail: "503" }]);
    const failed = await tick(root, runs, down);
    expect(failed.warnings.some((w) => w.includes("could not send ci.red") && w.includes("webhook 503"))).toBe(true);
    expect(readCiRecord(root, a)?.notified).toBeUndefined();
    const up = sink();
    await tick(root, runs, up);
    expect(up.sent.map((e) => e.event)).toEqual(["ci.red"]);
  });

  test("no ci.green.notify, no events and no notified field", async () => {
    const { root } = workspace({ ...GREEN, notify: undefined });
    const a = commitAt(root, 2, "app/a.txt");
    git(root, "push", "-q", "origin", "main");
    const s = sink();
    const result = await tick(root, new Map([[a, fail()]]), s);
    expect(s.sent).toEqual([]);
    expect(result.notified).toBeUndefined();
  });
});
