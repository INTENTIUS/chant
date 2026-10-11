/**
 * An Op a steward runs beside its turns (#2861): the declaration, a long run
 * that holds none of the steward's turns up, a hand run that takes the Op's
 * lease and not the turn, and the operator stopping the runs it started.
 */
import { describe, test, expect, vi } from "vitest";
import { withTestDir } from "@intentius/chant-test-utils";
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ActivityFn, ActivityProfile } from "./activity-registry";
import type { ActivityStep, OpConfig } from "./types";
import { declareSteward, readinessKeys, stewardBesideFor, stewardTurnOps, stewardTurnLeaseName } from "./steward";
import { createBesideState, formatRoundLine, runOperatorForever, runOperatorRound, waitForBesideRuns, type OperatorTickEvent } from "./operator";
import { askReady, holdBesideLease, inProcessBesideLauncher, type BesideLauncher } from "./steward-beside";
import { stepOutput } from "./step-output-ref";
import { readLease } from "../lifecycle/lease";
import { readRunLedger } from "../lifecycle/run-ledger";

const PROFILES: Record<string, ActivityProfile> = {};

function op(name: string, cron?: string, fn = "tick"): OpConfig {
  return {
    name,
    overview: `${name} fixture`,
    phases: [{ name: "Run", steps: [{ kind: "activity", fn, args: {} }] }],
    ...(cron ? { schedule: { cron, overlap: "skip" as const } } : {}),
  };
}

const ready = (fn = "ready"): ActivityStep => ({ kind: "activity", fn, args: {} });

function git(args: string[], cwd: string): void {
  spawnSync("git", args, { cwd, encoding: "utf-8" });
}

function initRepo(dir: string): void {
  git(["init", "-q", "-b", "main"], dir);
  git(["config", "user.email", "test@chant.dev"], dir);
  git(["config", "user.name", "Test"], dir);
  mkdirSync(join(dir, "app"), { recursive: true });
  writeFileSync(join(dir, "app", "index.ts"), "export const hello = 1;\n");
  git(["add", "app/index.ts"], dir);
  git(["commit", "-q", "-m", "init"], dir);
}

const kinds = (events: OperatorTickEvent[]) => events.map((e) => [e.kind, e.op]);

describe("declareSteward's beside (#2861)", () => {
  test("lists the Ops beside the turns after its turns' Ops, and names them", () => {
    const steward = declareSteward({
      name: "box-steward",
      ops: [op("converge", "* * * * *")],
      beside: [{ op: op("dispatch", undefined, "build"), ready: ready() }, op("rebuild", "0 3 * * *")],
    });
    expect(steward.ops.map((o) => o.name)).toEqual(["converge", "dispatch", "rebuild"]);
    expect(steward.beside).toEqual([{ op: "dispatch", ready: ready() }, { op: "rebuild", ready: null }]);
    expect(stewardTurnOps(steward).map((o) => o.name)).toEqual(["converge"]);
    expect(stewardBesideFor(steward, "dispatch")?.ready).toEqual(ready());
    expect(stewardBesideFor(steward, "converge")).toBeUndefined();
    // A declaration from before #2861 has no beside, and every Op is a turn.
    const { beside: _dropped, ...older } = steward;
    expect(stewardTurnOps(older as typeof steward).map((o) => o.name)).toEqual(["converge", "dispatch", "rebuild"]);
  });

  test("refuses an Op both in ops and beside, a ready that is not one activity step, and one that reads a step's output", () => {
    const converge = op("converge", "* * * * *");
    expect(() => declareSteward({ name: "s", ops: [converge], beside: [converge] })).toThrow(/listed twice/);
    expect(() =>
      declareSteward({ name: "s", ops: [], beside: [{ op: op("dispatch"), ready: { kind: "gate", gate: "g" } as unknown as ActivityStep }] }),
    ).toThrow(/ready is one activity step/);
    expect(() =>
      declareSteward({ name: "s", ops: [], beside: [{ op: op("dispatch"), ready: { kind: "activity", fn: "shellCmd", args: { cmd: stepOutput("pick", "json") } } }] }),
    ).toThrow(/reads another step's output/);
    // Started on its own, it can't be handed the work item a run names.
    const leased: OpConfig = { ...op("dispatch"), changesCheckout: true, workLease: {} };
    expect(() => declareSteward({ name: "s", ops: [], beside: [{ op: leased, ready: ready() }] })).toThrow(/workLease names no item/);
  });

  test("a ready step's answer: a list of keys, a string, true, or no work", () => {
    expect(readinessKeys({ stdout: "", json: ["W-1:0", "intent:ws-1"] })).toEqual({ ready: true, keys: ["W-1:0", "intent:ws-1"] });
    expect(readinessKeys([{ item: "W-2" }])).toEqual({ ready: true, keys: ['{"item":"W-2"}'] });
    expect(readinessKeys("W-3")).toEqual({ ready: true, keys: ["W-3"] });
    expect(readinessKeys(true)).toEqual({ ready: true, keys: [] });
    for (const none of [false, null, "", [], { json: null }]) expect(readinessKeys(none)).toEqual({ ready: false, keys: [] });
    expect(readinessKeys({ ready: [] })).toBeNull();
  });

  test("askReady reports a step that fails, answers in another shape, or isn't loaded", async () => {
    const acts = new Map<string, ActivityFn>([
      ["boom", async () => { throw new Error("no factory here"); }],
      ["odd", async () => ({ ready: [{ item: "W-1" }], held: null })],
    ]);
    expect(await askReady(ready("boom"), acts)).toEqual({ error: "no factory here" });
    expect(await askReady(ready("odd"), acts)).toMatchObject({ error: expect.stringContaining("neither true") });
    expect(await askReady(ready("missing"), acts)).toMatchObject({ error: expect.stringContaining('"missing" is not loaded') });
  });
});

describe("an Op beside a steward's turns (#2861)", () => {
  test("a long run beside a per-minute converge: converge ticks every minute while it runs, and no work is started twice", async () => {
    await withTestDir(async (dir) => {
      initRepo(dir);
      let finish: () => void = () => {};
      const building = new Promise<void>((resolve) => { finish = resolve; });
      const log: string[] = [];
      const activities = new Map<string, ActivityFn>([
        ["tick", async () => { log.push("converge"); return { ok: true }; }],
        ["build", async () => { log.push("build:start"); await building; log.push("build:end"); return { built: true }; }],
        ["ready", async () => ({ stdout: "", json: ["W-1:0"] })],
      ]);
      const steward = declareSteward({
        name: "box-steward",
        ops: [op("converge", "* * * * *")],
        beside: [{ op: op("dispatch", undefined, "build"), ready: ready() }],
      });
      const besideState = createBesideState();
      const scheduleState = new Map<string, Date>();
      const launchBeside = inProcessBesideLauncher(activities, PROFILES);
      // Cron minutes are local time, so the rounds are too. The leases use the
      // wall clock, so a fixed `now` is only handed to the cron.
      let minute = 1;
      const round = () => {
        const at = new Date(2026, 8, 25, 10, minute++, 0);
        return runOperatorRound({ cwd: dir, holder: "op1", steward, activities, profiles: PROFILES, besideState, scheduleState, launchBeside, now: () => at });
      };

      // 10:01: converge ticks as a turn; the ready step names work, and dispatch starts beside it.
      const first = await round();
      expect(kinds(first)).toEqual([["ticked", "converge"], ["beside-started", "dispatch"]]);
      expect(first[1]).toMatchObject({ why: "ready", keys: ["W-1:0"], holder: "box-steward/dispatch@op1" });
      expect(formatRoundLine(first[1])).toBe('operator: dispatch@local started=1(beside:ready) holder="box-steward/dispatch@op1" keys="W-1:0"');
      await vi.waitFor(() => expect(log).toContain("build:start"));

      // Mid-build the run holds the Op's own lease, and not the steward's turn.
      expect((await readLease("dispatch", { cwd: dir })).record?.holder).toBe("box-steward/dispatch@op1");
      expect((await readLease(stewardTurnLeaseName("box-steward"), { cwd: dir })).record).toBeUndefined();

      // 10:02 and 10:03: converge ticks each minute while the build runs, and no second run starts.
      for (let i = 0; i < 2; i++) {
        const mid = await round();
        expect(kinds(mid)).toEqual([["ticked", "converge"], ["beside-running", "dispatch"]]);
      }
      expect(log.filter((l) => l === "converge")).toHaveLength(3);
      expect(log).not.toContain("build:end");

      finish();
      await waitForBesideRuns(besideState);
      expect((await readLease("dispatch", { cwd: dir })).record).toBeUndefined();
      const run = (await readRunLedger("local", "dispatch", { cwd: dir })).records.at(-1)!;
      expect(run).toMatchObject({ status: "ok", steward: "box-steward" });

      // 10:04: the end is reported, and the same work still named is not started again.
      const after = await round();
      expect(after).toEqual([
        { kind: "beside-ended", op: "dispatch", env: "local", code: 0 },
        expect.objectContaining({ kind: "ticked", op: "converge" }),
        { kind: "skipped-not-ready", op: "dispatch", env: "local", already: ["W-1:0"] },
      ]);
      expect(log.filter((l) => l === "build:start")).toHaveLength(1);
    });
  });

  test("a hand run holds the Op's lease and not the turn: converge still ticks, and the operator starts no second run", async () => {
    await withTestDir(async (dir) => {
      initRepo(dir);
      const log: string[] = [];
      const activities = new Map<string, ActivityFn>([
        ["tick", async () => { log.push("converge"); return { ok: true }; }],
        ["ready", async () => true],
      ]);
      const steward = declareSteward({
        name: "box-steward",
        ops: [op("converge", "* * * * *")],
        beside: [{ op: op("dispatch", undefined, "build"), ready: ready() }],
      });
      const launched: string[] = [];
      const launchBeside: BesideLauncher = (start) => {
        launched.push(start.op.name);
        return { done: Promise.resolve({ code: 0 }), stop: () => {} };
      };

      // What `chant run dispatch` takes for an Op beside the turns.
      const hand = await holdBesideLease("dispatch", "hand-run", { cwd: dir });
      expect(hand.acquired).toBe(true);
      expect((await readLease(stewardTurnLeaseName("box-steward"), { cwd: dir })).record).toBeUndefined();

      const at = new Date(2026, 8, 25, 10, 1, 0);
      const events = await runOperatorRound({ cwd: dir, holder: "op1", steward, activities, profiles: PROFILES, launchBeside, now: () => at });
      expect(events.map((e) => e.kind)).toEqual(["ticked", "beside-running"]);
      expect(events[1]).toEqual({ kind: "beside-running", op: "dispatch", env: "local", heldBy: "hand-run" });
      expect(log).toEqual(["converge"]);
      expect(launched).toEqual([]);

      // A second hand run is refused while the first holds the lease.
      expect(await holdBesideLease("dispatch", "hand-run-2", { cwd: dir })).toEqual({ acquired: false, heldBy: "hand-run" });
      if (hand.acquired) await hand.release();
      expect((await readLease("dispatch", { cwd: dir })).record).toBeUndefined();
      const next = await runOperatorRound({ cwd: dir, holder: "op1", steward, activities, profiles: PROFILES, launchBeside, now: () => at });
      expect(next.map((e) => e.kind)).toContain("beside-started");
      expect(launched).toEqual(["dispatch"]);
    });
  });

  test("the lease a long run holds is renewed while it runs", async () => {
    await withTestDir(async (dir) => {
      initRepo(dir);
      const held = await holdBesideLease("dispatch", "h", { cwd: dir, ttlMs: 900 });
      expect(held.acquired).toBe(true);
      if (!held.acquired) return;
      const first = held.lease.expiresAt;
      await vi.waitFor(async () => {
        const now = (await readLease("dispatch", { cwd: dir })).record;
        expect(now?.token).toBe(held.lease.token);
        expect(now!.expiresAt > first).toBe(true);
      }, { timeout: 3000 });
      await held.release();
    });
  });

  test("a cron fire starts it, and one that fires while a run is in flight is dropped", async () => {
    await withTestDir(async (dir) => {
      initRepo(dir);
      const steward = declareSteward({ name: "box-steward", ops: [], beside: [op("nightly", "0 3 * * *")] });
      let end: () => void = () => {};
      const launchBeside: BesideLauncher = () => ({ done: new Promise((resolve) => { end = () => resolve({ code: 0 }); }), stop: () => {} });
      const besideState = createBesideState();
      const scheduleState = new Map<string, Date>();
      const round = (h: number, m: number) =>
        runOperatorRound({ cwd: dir, holder: "op1", steward, activities: new Map(), profiles: PROFILES, besideState, scheduleState, launchBeside, now: () => new Date(2026, 8, 25, h, m, 0) });
      expect(kinds(await round(2, 59))).toEqual([["skipped-not-due", "nightly"]]);
      expect(await round(3, 0)).toEqual([expect.objectContaining({ kind: "beside-started", op: "nightly", why: "cron" })]);
      expect(kinds(await round(3, 1))).toEqual([["beside-running", "nightly"]]);
      end();
      await waitForBesideRuns(besideState);
      expect(kinds(await round(3, 2))).toEqual([["beside-ended", "nightly"], ["skipped-not-due", "nightly"]]);
    });
  });

  test("the operator stops the runs it started when it stops", async () => {
    await withTestDir(async (dir) => {
      initRepo(dir);
      const steward = declareSteward({ name: "box-steward", ops: [], beside: [{ op: op("dispatch"), ready: ready() }] });
      const controller = new AbortController();
      const stopped: string[] = [];
      const launchBeside: BesideLauncher = (start) => {
        let end: (code: number) => void = () => {};
        const done = new Promise<{ code: number }>((resolve) => { end = (code) => resolve({ code }); });
        return { done, stop: () => { stopped.push(start.op.name); end(1); } };
      };
      await runOperatorForever({
        cwd: dir,
        holder: "op1",
        steward,
        activities: new Map<string, ActivityFn>([["ready", async () => true]]),
        profiles: PROFILES,
        launchBeside,
        intervalMs: 10,
        signal: controller.signal,
        onRound: (events) => {
          if (events.some((e) => e.kind === "beside-started")) controller.abort();
        },
      });
      expect(stopped).toEqual(["dispatch"]);
    });
  });
});
