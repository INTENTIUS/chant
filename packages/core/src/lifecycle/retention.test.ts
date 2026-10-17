/**
 * Retention's garbage collection (#4036) against temp repos: each never-prune
 * rule, the window, the prune commit and what it leaves alone.
 *
 * Records are written now, and the GC is planned at `NOW`, a month later, so
 * what a test writes is old unless a timestamp it sets says otherwise. They
 * are written as the stores write them, in one commit per test to keep it
 * fast; the stores' own writers are tested beside them.
 */

import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { withTestDir } from "@intentius/chant-test-utils";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { contentDigest } from "../content-digest";
import { makeRelease, type Release } from "./release-store";
import type { ReleaseRecord } from "./release-ledger";
import type { GateResolutionInput, PendingGateInput } from "./gate-ledger";
import { writeLedgerFiles, RefCASConflictError } from "./git";
import { digestKey, planLifecycleGc, runLifecycleGc, splitLedgerPath, type GcInput } from "./retention";
import { DEFAULT_RETENTION, resolveRetention, type RetentionPolicy } from "./retention-policy";
import { planRunEventPrune, pruneRunEvents, RUN_EVENTS_DIR_ENV } from "../run-event-store";

const DAY = 86_400_000;
const NOW = new Date(Date.now() + 30 * DAY);
const recent = (daysBefore = 1) => new Date(NOW.getTime() - daysBefore * DAY).toISOString();
const old = new Date(Date.now() - DAY).toISOString();

/** Keep nothing by count, so only the rules and the window keep anything. */
const STRICT: RetentionPolicy = { changeSets: { days: 7, keep: 0 }, releases: { days: 7, keep: 0 }, runEvents: { days: 7, keep: 0 } };

function git(dir: string, ...args: string[]): string {
  const r = spawnSync("git", args, { cwd: dir, encoding: "utf-8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
}

function initRepo(dir: string): void {
  git(dir, "init", "-q", "-b", "main");
  git(dir, "config", "user.email", "t@chant.dev");
  git(dir, "config", "user.name", "T");
  writeFileSync(join(dir, "README.md"), "x\n");
  git(dir, "add", ".");
  git(dir, "commit", "-q", "-m", "init");
}

/** Files to write, flushed in one commit before a plan reads the branch. */
const buffered = new Map<string, string>();
const append = (path: string, line: object) => buffered.set(path, `${buffered.get(path) ?? ""}${JSON.stringify(line)}\n`);
async function flush(dir: string): Promise<void> {
  if (buffered.size === 0) return;
  const files = [...buffered].map(([path, content]) => ({ path, content }));
  buffered.clear();
  await writeLedgerFiles(files, "fixture", { cwd: dir });
}

let n = 0;
/** A release with one template, stored and cut, as `persistRelease` and `appendCut` write it. */
function release(_dir: string, opts: { template?: string; cutAt?: string; commit?: string } = {}): Release {
  const tpl = opts.template ?? `kind: Deployment # ${++n}\n`;
  const digest = contentDigest(tpl);
  const r = makeRelease({
    member: null,
    commit: opts.commit ?? `${String(++n).padStart(4, "0")}${"a".repeat(36)}`,
    artifactDigests: [{ component: "api", kind: "image", path: "api.tar", digest: `sha256:${String(n).padStart(64, "0")}` }],
    targets: [{ env: "prod", templates: [{ component: "api", path: "api.yaml", digest }], params: [] }],
  });
  buffered.set(releasePath(r), `${JSON.stringify(r)}\n`);
  buffered.set(templatePath(r), tpl);
  append("_releases/cuts.jsonl", { version: 1, releaseDigest: r.releaseDigest, label: null, actor: "a", timestamp: opts.cutAt ?? old, runOrigin: null, signature: null });
  return r;
}

const appendReleaseRecord = (record: Omit<ReleaseRecord, "version">, _opts?: unknown) => append(`${record.env}/releases.jsonl`, { version: 1, ...record });
const appendGateResolution = (r: GateResolutionInput, _opts?: unknown) => append(`_gates/${r.op}.jsonl`, { version: 1, kind: "resolution", ...r });
const appendPendingGate = (p: PendingGateInput, _opts?: unknown) => append(`_gates/${p.op}.jsonl`, { version: 1, kind: "pending", ...p });

const changeSetDigest = (i: number) => `jcs1-sha256:${i.toString(16).padStart(64, "0")}`;
function storeChangeSet(_dir: string, digest: string, prefix = ""): string {
  const path = `${prefix}_change-sets/${digest.replace(/:/g, "_")}.json`;
  buffered.set(path, `${JSON.stringify({ digest })}\n`);
  return path;
}

async function gcPlan(i: GcInput): Promise<ReturnType<typeof planLifecycleGc>> {
  await flush(i.cwd);
  return planLifecycleGc(i);
}
async function gcRun(i: Parameters<typeof runLifecycleGc>[0]): ReturnType<typeof runLifecycleGc> {
  await flush(i.cwd);
  return runLifecycleGc(i);
}

const input = (dir: string, policy: RetentionPolicy = STRICT, extra: Partial<GcInput> = {}): GcInput => ({ cwd: dir, policy, now: NOW, ...extra });
const removed = (plan: ReturnType<typeof planLifecycleGc>) => plan.remove.map((f) => f.path);
const kept = (plan: ReturnType<typeof planLifecycleGc>, path: string) => plan.keep.find((f) => f.path === path)?.reasons.map((r) => r.code);
const releasePath = (r: Release, prefix = "") => `${prefix}_releases/${r.releaseDigest.replace(/:/g, "_")}.json`;
const templatePath = (r: Release, prefix = "") => `${prefix}_releases/templates/${r.targets[0].templates[0].digest.replace(/:/g, "_")}.txt`;

let eventsDir: string;
let priorEventsDir: string | undefined;
beforeEach(() => {
  // GC deletes run event files: point it at a directory of this test's own.
  priorEventsDir = process.env[RUN_EVENTS_DIR_ENV];
  eventsDir = mkdtempSync(join(tmpdir(), "chant-gc-events-"));
  process.env[RUN_EVENTS_DIR_ENV] = eventsDir;
});
afterEach(() => {
  if (priorEventsDir === undefined) delete process.env[RUN_EVENTS_DIR_ENV];
  else process.env[RUN_EVENTS_DIR_ENV] = priorEventsDir;
  rmSync(eventsDir, { recursive: true, force: true });
});

describe("never-prune rules", () => {
  test("a release an environment runs is kept with its templates, by releaseDigest or by the admission's resolution", async () => {
    await withTestDir(async (dir) => {
      initRepo(dir);
      const running = await release(dir);
      const viaAdmission = await release(dir);
      const superseded = await release(dir);
      const unused = await release(dir);
      const rec = (component: string, timestamp: string, extra: object) =>
        appendReleaseRecord({ component, env: "prod", digest: "sha256:1", gitSha: "c".repeat(40), runId: `r-${timestamp}`, timestamp, actor: "ci", ...extra }, { cwd: dir });
      // api ran `superseded`, then `running`: only the latest record counts.
      await rec("api", "2026-10-01T00:00:00.000Z", { releaseDigest: superseded.releaseDigest });
      await rec("api", "2026-10-02T00:00:00.000Z", { releaseDigest: running.releaseDigest });
      // web's latest record names no release, and its admission's release gate resolution does.
      await appendGateResolution({ op: "release", gate: "ship", resolvedBy: "bob", timestamp: "2026-10-03T00:00:00.000Z", planDigest: changeSetDigest(1), releaseDigest: viaAdmission.releaseDigest, environment: "prod" }, { cwd: dir });
      await rec("web", "2026-10-03T00:00:01.000Z", { admission: { op: "release", gate: "ship", resolvedAt: "2026-10-03T00:00:00.000Z" } });

      const plan = await gcPlan(input(dir));
      expect(kept(plan, releasePath(running))).toEqual(["deployed"]);
      expect(kept(plan, templatePath(running))).toEqual(["kept-release"]);
      expect(kept(plan, releasePath(viaAdmission))).toEqual(["deployed"]);
      expect(removed(plan)).toEqual(expect.arrayContaining([releasePath(superseded), templatePath(superseded), releasePath(unused), templatePath(unused)]));
      expect(plan.remove).toHaveLength(4);
    });
  });

  test("what a pending gate binds is kept until its fact expires", async () => {
    await withTestDir(async (dir) => {
      initRepo(dir);
      const bound = await release(dir);
      const lapsed = await release(dir);
      const live = await storeChangeSet(dir, changeSetDigest(10));
      const expired = await storeChangeSet(dir, changeSetDigest(11));
      await appendPendingGate({ op: "pr-12", gate: "review", timestamp: old, expiresAt: new Date(NOW.getTime() + DAY).toISOString(), planDigest: changeSetDigest(10) }, { cwd: dir });
      await appendPendingGate({ op: "release", gate: "ship", timestamp: old, expiresAt: new Date(NOW.getTime() + DAY).toISOString(), planDigest: changeSetDigest(12), releaseDigest: bound.releaseDigest, environment: "prod" }, { cwd: dir });
      // Expired a day before NOW: binds nothing, and its fact is too old to keep the change set in the window.
      await appendPendingGate({ op: "pr-13", gate: "review", timestamp: old, expiresAt: recent(1), planDigest: changeSetDigest(11) }, { cwd: dir });
      await appendPendingGate({ op: "release", gate: "ship", timestamp: old, expiresAt: recent(1), releaseDigest: lapsed.releaseDigest, environment: "staging" }, { cwd: dir });

      const plan = await gcPlan(input(dir));
      expect(kept(plan, live)).toEqual(["pending-gate"]);
      expect(kept(plan, releasePath(bound))).toEqual(["pending-gate"]);
      expect(kept(plan, templatePath(bound))).toEqual(["kept-release"]);
      expect(removed(plan)).toEqual(expect.arrayContaining([expired, releasePath(lapsed)]));
    });
  });

  test("a release is promotable within the window or among the newest of its member, and never when its commit is revoked", async () => {
    await withTestDir(async (dir) => {
      initRepo(dir);
      const oldest = await release(dir, { cutAt: "2026-01-01T00:00:00.000Z" });
      const older = await release(dir, { cutAt: "2026-01-02T00:00:00.000Z" });
      const newer = await release(dir, { cutAt: "2026-01-03T00:00:00.000Z" });
      const fresh = await release(dir, { cutAt: recent(2) });
      const revokedFresh = await release(dir, { cutAt: recent(1), commit: "f".repeat(40) });
      const revokedRunning = await release(dir, { commit: "e".repeat(40) });
      await appendReleaseRecord({ component: "api", env: "prod", digest: "sha256:1", gitSha: "e".repeat(40), runId: "r1", timestamp: old, actor: "ci", releaseDigest: revokedRunning.releaseDigest }, { cwd: dir });

      const policy = { ...STRICT, releases: { days: 7, keep: 2 } };
      const plan = await gcPlan(input(dir, policy, { revokedCommits: new Set(["f".repeat(40), "e".repeat(40)]) }));
      // The newest two promotable are `fresh` and `newer`; revoked ones don't count toward keep.
      expect(kept(plan, releasePath(fresh))).toEqual(["newest", "within-window"]);
      expect(kept(plan, releasePath(newer))).toEqual(["newest"]);
      expect(kept(plan, releasePath(revokedRunning))).toEqual(["deployed"]);
      expect(removed(plan)).toEqual(expect.arrayContaining([releasePath(oldest), releasePath(older), releasePath(revokedFresh)]));
      expect(plan.remove.filter((f) => f.kind === "release")).toHaveLength(3);
    });
  });

  test("a change set an approval or empty resolution names is kept while its release is kept", async () => {
    await withTestDir(async (dir) => {
      initRepo(dir);
      const keptRelease = await release(dir, { cutAt: recent(1) });
      const prunedRelease = await release(dir);
      const approved = await storeChangeSet(dir, changeSetDigest(20));
      const empty = await storeChangeSet(dir, changeSetDigest(21));
      const orphaned = await storeChangeSet(dir, changeSetDigest(22));
      const res = (planDigest: string, releaseDigest: string, extra: object = {}) =>
        appendGateResolution({ op: "release", gate: "ship", resolvedBy: "bob", timestamp: old, planDigest, releaseDigest, environment: "prod", ...extra }, { cwd: dir });
      await res(changeSetDigest(20), keptRelease.releaseDigest);
      await res(changeSetDigest(21), keptRelease.releaseDigest, { empty: true });
      await res(changeSetDigest(22), prunedRelease.releaseDigest);

      const plan = await gcPlan(input(dir));
      expect(kept(plan, approved)).toEqual(["kept-release"]);
      expect(kept(plan, empty)).toEqual(["kept-release"]);
      expect(removed(plan)).toEqual(expect.arrayContaining([orphaned, releasePath(prunedRelease)]));
    });
  });

  test("a template two releases share stays while either is kept", async () => {
    await withTestDir(async (dir) => {
      initRepo(dir);
      const shared = "kind: Service\n";
      const a = await release(dir, { template: shared, cutAt: recent(1) });
      const b = await release(dir, { template: shared });
      const plan = await gcPlan(input(dir));
      expect(removed(plan)).toEqual([releasePath(b)]);
      expect(kept(plan, templatePath(a))).toEqual(["kept-release"]);
    });
  });

  test("a release file that can't be read is kept, and so is every template of its member", async () => {
    await withTestDir(async (dir) => {
      initRepo(dir);
      const r = await release(dir);
      await writeLedgerFiles([{ path: "_releases/jcs1-sha256_" + "9".repeat(64) + ".json", content: "{", expectPriorSha: null }], "broken", { cwd: dir });
      const plan = await gcPlan(input(dir));
      expect(removed(plan)).toEqual([releasePath(r)]);
      expect(kept(plan, templatePath(r))).toEqual(["unreadable"]);
    });
  });
});

describe("the window", () => {
  test("a change set stays for changeSets.days after it was stored or last named by a gate fact", async () => {
    await withTestDir(async (dir) => {
      initRepo(dir);
      const stale = await storeChangeSet(dir, changeSetDigest(30));
      const named = await storeChangeSet(dir, changeSetDigest(31));
      await appendGateResolution({ op: "pr-31", gate: "review", resolvedBy: "bob", timestamp: recent(3), planDigest: changeSetDigest(31) }, { cwd: dir });
      expect(removed(await gcPlan(input(dir)))).toEqual([stale]);
      expect(kept(await gcPlan(input(dir)), named)).toEqual(["within-window"]);
      // Planned today, both were stored within the window.
      expect((await gcPlan({ ...input(dir), now: new Date() })).remove).toEqual([]);
    });
  });

  test("a digest written sha256:<hex> matches the file stored as jcs1-sha256_<hex>", () => {
    expect(digestKey("sha256:" + "a".repeat(64))).toBe(digestKey("jcs1-sha256_" + "a".repeat(64)));
  });
});

describe("the prune", () => {
  test("members are read under their own prefix", async () => {
    await withTestDir(async (dir) => {
      initRepo(dir);
      expect(splitLedgerPath("_members/api/_members/db/_releases/x.json")).toEqual({ prefix: "_members/api/_members/db/", member: "api/db", rest: "_releases/x.json" });
      const prefix = "_members/api/";
      const cs = await storeChangeSet(dir, changeSetDigest(40), prefix);
      // The flat layout's pending fact for the same digest binds nothing in the member.
      await appendPendingGate({ op: "pr-40", gate: "review", timestamp: old, expiresAt: new Date(NOW.getTime() + DAY).toISOString(), planDigest: changeSetDigest(40) }, { cwd: dir });
      const plan = await gcPlan(input(dir));
      expect(plan.remove.map((f) => [f.path, f.member])).toEqual([[cs, "api"]]);
    });
  });

  test("a prune is one new commit on the old tip that removes files; ledgers and history are untouched, and nothing is pushed", async () => {
    await withTestDir(async (dir) => {
      initRepo(dir);
      const remote = mkdtempSync(join(tmpdir(), "chant-gc-remote-"));
      try {
        git(remote, "init", "-q", "--bare");
        git(dir, "remote", "add", "origin", remote);
        const r = await release(dir);
        await appendReleaseRecord({ component: "api", env: "prod", digest: "sha256:1", gitSha: "c".repeat(40), runId: "r1", timestamp: old, actor: "ci" }, { cwd: dir });
        const cs = await storeChangeSet(dir, changeSetDigest(50));
        await flush(dir);
        git(dir, "push", "-q", "origin", "chant/lifecycle");
        const before = git(dir, "rev-parse", "chant/lifecycle");
        const ledgers = () => git(dir, "ls-tree", "-r", "chant/lifecycle").split("\n").filter((l) => l.endsWith(".jsonl")).join("\n");
        const ledgersBefore = ledgers();

        const dry = await gcRun({ ...input(dir), dryRun: true });
        expect(dry.lifecycle.commit).toBeNull();
        expect(git(dir, "rev-parse", "chant/lifecycle")).toBe(before);

        const report = await gcRun({ ...input(dir), dryRun: false });
        const after = git(dir, "rev-parse", "chant/lifecycle");
        expect(report.lifecycle.commit).toBe(after);
        expect(git(dir, "rev-parse", `${after}^`)).toBe(before);
        expect(git(dir, "log", "-1", "--format=%s", after)).toBe("Retention: remove 1 change set(s), 1 release(s) and 1 template(s)");
        expect(git(dir, "ls-tree", "-r", "--name-only", "chant/lifecycle").split("\n").sort()).toEqual(["_releases/cuts.jsonl", "prod/releases.jsonl"]);
        expect(ledgers()).toBe(ledgersBefore);
        // History still holds every removed file.
        expect(git(dir, "cat-file", "-p", `${before}:${cs}`)).toContain(changeSetDigest(50));
        expect(git(dir, "cat-file", "-p", `${before}:${releasePath(r)}`)).toContain(r.releaseDigest);
        expect(report.lifecycle.pushed).toBe(false);
        expect(git(remote, "rev-parse", "chant/lifecycle")).toBe(before);
        expect(report.lifecycle.after.ledgers).toEqual(report.lifecycle.before.ledgers);
        expect(report.lifecycle.after.files).toBe(2);

        // A second run finds nothing, and writes nothing.
        const again = await gcRun({ ...input(dir), dryRun: false });
        expect(again.lifecycle.remove).toEqual([]);
        expect(again.lifecycle.commit).toBeNull();

        // --push sends it as a fast-forward.
        await storeChangeSet(dir, changeSetDigest(51));
        const pushed = await gcRun({ ...input(dir), dryRun: false, push: true });
        expect(pushed.lifecycle.pushed).toBe(true);
        expect(git(remote, "rev-parse", "chant/lifecycle")).toBe(pushed.lifecycle.commit);
        expect(git(remote, "merge-base", "--is-ancestor", before, "chant/lifecycle")).toBe("");
      } finally {
        rmSync(remote, { recursive: true, force: true });
      }
    });
  });

  test("a removal against a moved tip is a conflict, and an emptied directory leaves the tree", async () => {
    await withTestDir(async (dir) => {
      initRepo(dir);
      const cs = await storeChangeSet(dir, changeSetDigest(60));
      await flush(dir);
      const tip = git(dir, "rev-parse", "chant/lifecycle");
      const sha = git(dir, "rev-parse", `chant/lifecycle:${cs}`);
      await storeChangeSet(dir, changeSetDigest(61));
      await flush(dir);
      await expect(writeLedgerFiles([{ path: cs, remove: true, expectPriorSha: sha }], "gc", { cwd: dir, expectTip: tip })).rejects.toBeInstanceOf(RefCASConflictError);
      const other = `_change-sets/${changeSetDigest(61).replace(/:/g, "_")}.json`;
      await writeLedgerFiles([{ path: cs, remove: true, expectPriorSha: sha }, { path: other, remove: true }, { path: "_gates/x.jsonl", content: "{}\n" }], "gc", { cwd: dir });
      expect(git(dir, "ls-tree", "-r", "--name-only", "chant/lifecycle")).toBe("_gates/x.jsonl");
    });
  });
});

describe("run events", () => {
  test("files older than the window go, apart from the newest keep", async () => {
    const at = (name: string, daysAgo: number) => {
      const file = join(eventsDir, name);
      writeFileSync(file, '{"runId":"x"}\n');
      const t = (NOW.getTime() - daysAgo * DAY) / 1000;
      utimesSync(file, t, t);
    };
    mkdirSync(eventsDir, { recursive: true });
    at("a.jsonl", 1);
    at("b.jsonl", 20);
    at("c.jsonl", 30);
    at("d.jsonl", 40);
    writeFileSync(join(eventsDir, "notes.txt"), "not an event file\n");
    const plan = await planRunEventPrune(eventsDir, { days: 7, keep: 2 }, NOW);
    expect(plan.keep.map((f) => f.file.split("/").pop())).toEqual(["a.jsonl", "b.jsonl"]);
    expect(plan.remove.map((f) => f.file.split("/").pop())).toEqual(["c.jsonl", "d.jsonl"]);
    expect(pruneRunEvents(plan)).toBe(2);
    expect(readdirSync(eventsDir).sort()).toEqual(["a.jsonl", "b.jsonl", "notes.txt"]);
  });
});

describe("the policy", () => {
  test("an override replaces only the fields it sets; changeSets takes no keep", () => {
    expect(resolveRetention(null)).toEqual(DEFAULT_RETENTION);
    expect(resolveRetention({ releases: { keep: 3 }, changeSets: { days: 30, keep: 9 } })).toEqual({
      ...DEFAULT_RETENTION,
      changeSets: { days: 30, keep: 0 },
      releases: { days: DEFAULT_RETENTION.releases.days, keep: 3 },
    });
  });
});
