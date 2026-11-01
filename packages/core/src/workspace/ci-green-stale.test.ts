/**
 * #4678 — ci.stale: the branch has had no green commit for staleAfter hours.
 * Sent once per red stretch, remembered in _ci/branch/<branch>.json, and
 * ended by the ci.green of a newer green commit.
 */

import { execFileSync } from "node:child_process";
import { afterAll, describe, expect, test } from "vitest";
import { cleanScratch, declaration, git, scratchDir, writeFiles } from "./__fixtures__/contract-repo";
import { ciTick, readGreen, staleEvents, type StaleWalkCommit } from "./ci-green";
import type { CheckRun, CiForge } from "./ci-green-forge";
import { readCiBranchRecord, type CiBranchRecord } from "./ci-builds";
import type { CiGreen } from "./declaration";
import type { NotifyConfig, NotifyEvent } from "../notify";

afterAll(cleanScratch);

const NOW = new Date("2026-10-20T12:00:00Z");
const hoursAgo = (h: number, now = NOW) => new Date(now.getTime() - h * 3_600_000).toISOString().replace(/\.\d{3}Z$/, "Z");
const later = (h: number) => new Date(NOW.getTime() + h * 3_600_000);
const sha = (n: number) => n.toString(16).padStart(40, "0");

const GREEN: CiGreen = { branch: "main", window: "24h", phases: [], require: [], signedSince: null, source: "checks", notify: { slack: "SLACK", staleAfter: 6 }, pointer: "/ci/green" };

/** Commits newest first, `hours` ago each. */
const walkOf = (...hours: number[]): StaleWalkCommit[] => hours.map((h, i) => ({ sha: sha(hours.length - i), committed: hoursAgo(h) }));

function decide(walk: StaleWalkCommit[], green: number[], more: { stale?: CiBranchRecord["stale"]; answering?: string; judged?: (s: string) => boolean; staleAfter?: number | null } = {}) {
  return staleEvents({
    green: { ...GREEN, notify: { slack: "SLACK", ...(more.staleAfter === null ? {} : { staleAfter: more.staleAfter ?? 6 }) } },
    walk,
    isGreen: (s) => green.map(sha).includes(s),
    judged: more.judged ?? (() => true),
    stale: more.stale,
    answering: more.answering,
    now: NOW,
  });
}

describe("which stretch is stale (#4678)", () => {
  test("ci.stale when the oldest commit above the newest green one is staleAfter hours old, naming the tip, it and the green commit", () => {
    // 4 is the tip, 1 is green; 2 landed 7 hours ago.
    const { events } = decide(walkOf(1, 5, 7, 30), [1]);
    expect(events).toHaveLength(1);
    expect(events[0]!.fields).toMatchObject({
      event: "ci.stale",
      summary: `main has had no green commit for 7 hours: 3 commits since ${sha(2).slice(0, 12)}, above the green ${sha(1).slice(0, 12)}`,
      ci: { branch: "main", commit: sha(4), since: sha(2), lastGreen: sha(1), hours: 7 },
      run: { commit: sha(4) },
    });
    expect(events[0]!.stale).toEqual({ since: sha(2), lastGreen: sha(1), at: "2026-10-20T12:00:00Z" });
  });

  test("nothing before staleAfter, with a green tip, or without staleAfter", () => {
    expect(decide(walkOf(1, 5, 30), [1]).events).toEqual([]);
    expect(decide(walkOf(10, 30), [2]).events).toEqual([]);
    expect(decide(walkOf(1, 7, 30), [1], { staleAfter: null }).events).toEqual([]);
  });

  test("with no green commit in the walk, the stretch starts at the oldest commit the tick judged", () => {
    const judged = (s: string) => s !== sha(1);
    // 1 (100 hours ago) was never judged, so the stretch is 3 and 2, from 8 hours ago.
    const { events } = decide(walkOf(1, 8, 100), [], { judged });
    expect(events[0]!.fields.ci).toEqual({ branch: "main", commit: sha(3), since: sha(2), hours: 8 });
    expect(decide(walkOf(1, 8, 100), [], { judged: () => false }).events).toEqual([]);
  });

  test("an open stretch is told once, however long it lasts and wherever its first commit has gone", () => {
    const open = { since: sha(2), lastGreen: sha(1), at: hoursAgo(1) };
    expect(decide(walkOf(1, 5, 7, 30), [1], { stale: open }).events).toEqual([]);
    // No green commit within the walk: still the same stretch.
    expect(decide(walkOf(1, 5, 7), [], { stale: { ...open, since: sha(99) } }).events).toEqual([]);
  });

  test("a newer green commit ends the stretch with ci.green naming its since", () => {
    const open = { since: sha(2), lastGreen: sha(1), at: hoursAgo(1) };
    // 3 turned green.
    const { events, endedBy } = decide(walkOf(1, 5, 7, 30), [1, 3], { stale: open });
    expect(endedBy).toBeUndefined();
    expect(events.map((e) => [e.fields.event, e.fields.ci])).toEqual([["ci.green", { branch: "main", commit: sha(3), since: sha(2) }]]);
    expect(events[0]!.stale).toEqual({ ...open, ended: sha(3) });
  });

  test("when the tick sends ci.green anyway, that one ends the stretch and no second is sent", () => {
    const open = { since: sha(2), lastGreen: sha(1), at: hoursAgo(1) };
    const { events, endedBy } = decide(walkOf(1, 5, 7, 30), [1, 4], { stale: open, answering: sha(4) });
    expect(events).toEqual([]);
    expect(endedBy).toEqual({ ...open, ended: sha(4) });
  });

  test("an ended stretch doesn't hold back the next one", () => {
    const ended = { since: sha(2), lastGreen: sha(1), at: hoursAgo(20), ended: sha(3) };
    // 3 was green; 4 and 5 came after it, 4 nine hours ago.
    const { events } = decide(walkOf(2, 9, 12, 13, 30), [1, 3], { stale: ended });
    expect(events.map((e) => [e.fields.event, e.fields.ci?.since])).toEqual([["ci.stale", sha(4)]]);
  });
});

// ── through the tick ─────────────────────────────────────────────────────────

const NOTIFY = { webhook: "HOOK_URL", key: "HOOK_KEY", staleAfter: 6 };
const DECLARED = { branch: "main", phases: { lint: ["lint"], test: ["test"] }, require: ["lint", "test"], notify: NOTIFY };

function commitAt(root: string, hours: number, file: string): string {
  writeFiles(root, { [file]: `${file} ${hours}\n` });
  const env = { ...process.env, GIT_AUTHOR_DATE: hoursAgo(hours), GIT_COMMITTER_DATE: hoursAgo(hours) };
  const g = (...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", ...args], { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] });
  g("add", "-A");
  g("commit", "-q", "-m", file);
  return git(root, "rev-parse", "HEAD");
}

function workspace(green: unknown = DECLARED): string {
  const origin = scratchDir("chant-stale-origin-");
  git(origin, "init", "-q", "--bare");
  const root = scratchDir("chant-stale-work-");
  git(root, "init", "-q");
  git(root, "symbolic-ref", "HEAD", "refs/heads/main");
  writeFiles(root, { "chant.workspace.json": declaration([{ name: "app", dir: "app", kind: "other", because: "the app" }], { ci: { green } }), "app/a.txt": "a\n" });
  git(root, "remote", "add", "origin", origin);
  return root;
}

let id = 1;
const run = (name: string, conclusion: string | null): CheckRun => ({ id: id++, name, status: conclusion === null ? "in_progress" : "completed", conclusion, completedAt: null, url: null });
const pass = () => [run("lint", "success"), run("test", "success")];
const stuck = () => [run("lint", "success"), run("test", null)];

function sink() {
  const sent: NotifyEvent[] = [];
  const send = async (config: NotifyConfig | undefined, e: NotifyEvent | undefined) => {
    if (!config || !e) return [];
    sent.push(e);
    return [{ target: "webhook" as const, ok: true, detail: "delivered" }];
  };
  return { sent, send };
}

const tick = (root: string, runs: Map<string, CheckRun[]>, s: ReturnType<typeof sink>, now: Date, more: { dryRun?: boolean } = {}) =>
  ciTick({ cwd: root, forge: { kind: "github", checkRuns: async (c) => runs.get(c) ?? [] }, now, env: {}, sendNotify: s.send, ...more });

describe("ci.stale through the tick (#4678)", () => {
  test("staleAfter is read with notify's settings, and must be more than 0 hours", () => {
    expect(readGreen(workspace()).green.notify).toEqual(NOTIFY);
    for (const staleAfter of [0, "6h"]) expect(() => readGreen(workspace({ ...DECLARED, notify: { ...NOTIFY, staleAfter } }))).toThrow(/staleAfter/);
  });

  /** a is green; b, 4 hours old at NOW, has a run that never finishes. */
  function stuckBranch() {
    const root = workspace();
    const a = commitAt(root, 10, "app/a.txt");
    const b = commitAt(root, 4, "app/b.txt");
    git(root, "push", "-q", "origin", "main");
    const runs = new Map([
      [a, pass()],
      [b, stuck()],
    ]);
    return { root, a, b, runs };
  }

  test("later ticks with no new commit send ci.stale once, marked in the branch's record", async () => {
    const { root, a, b, runs } = stuckBranch();
    const s = sink();
    await tick(root, runs, s, NOW);
    expect(s.sent).toEqual([]);
    // Three hours on, nothing has landed and b is still running.
    const dry = await tick(root, runs, s, later(3), { dryRun: true });
    expect(dry.notified).toEqual([{ event: "ci.stale", commit: b, sent: false }]);
    const told = await tick(root, runs, s, later(3));
    expect(s.sent.map((e) => [e.event, e.ci])).toEqual([["ci.stale", { branch: "main", commit: b, since: b, lastGreen: a, hours: 7 }]]);
    expect(told.recorded).toContain("_ci/branch/main.json");
    expect(readCiBranchRecord(root, "main")?.stale).toEqual({ since: b, lastGreen: a, at: hoursAgo(-3) });
    await tick(root, runs, s, later(5));
    expect(s.sent).toHaveLength(1);
  });

  test("a newer green commit ends the stretch with one ci.green naming since", async () => {
    const { root, b, runs } = stuckBranch();
    const s = sink();
    await tick(root, runs, s, later(3));
    const c = commitAt(root, -6, "app/c.txt");
    git(root, "push", "-q", "origin", "main");
    runs.set(c, pass());
    await tick(root, runs, s, later(7));
    expect(s.sent.map((e) => [e.event, e.ci?.commit, e.ci?.since])).toEqual([
      ["ci.stale", b, b],
      ["ci.green", c, b],
    ]);
    expect(readCiBranchRecord(root, "main")?.stale?.ended).toBe(c);
    await tick(root, runs, s, later(8));
    expect(s.sent).toHaveLength(2);
  });
});
