/**
 * #4660: a hold left by a job that failed, lost its lock push or was
 * cancelled must not block later waves forever, and a hold of a live job
 * must still block. A bare remote and one clone per writer, as in
 * resource-lock-wait.test.ts; the clock and the pause are the test's.
 */
import { afterAll, describe, expect, test } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stackRowKey, type LockRow } from "./lock-rows";
import { runBeatLoop } from "./lock-beat";
import {
  beatLockRows,
  clearRunLockRows,
  forgeLockLiveness,
  leaseLockRows,
  readLockRows,
  takeLockRows,
  waitLockRows,
  withWaiter,
  type LockRowHolder,
} from "./resource-lock";

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

function tmp(prefix: string): string {
  const d = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  dirs.push(d);
  return d;
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function writers(n: number): { remote: string; clones: string[] } {
  const remote = tmp("chant-lock-live-remote-");
  git(remote, "init", "-q", "--bare", "-b", "main");
  const seed = tmp("chant-lock-live-seed-");
  git(seed, "init", "-q", "-b", "main");
  git(seed, "config", "user.email", "seed@chant.dev");
  git(seed, "config", "user.name", "Seed");
  git(seed, "config", "commit.gpgsign", "false");
  writeFileSync(join(seed, "README.md"), "# t\n");
  git(seed, "add", "README.md");
  git(seed, "commit", "-q", "-m", "init");
  git(seed, "remote", "add", "origin", remote);
  git(seed, "push", "-q", "origin", "main");
  const clones: string[] = [];
  for (let i = 0; i < n; i++) {
    const c = tmp(`chant-lock-live-clone-${i}-`);
    git(c, "clone", "-q", remote, ".");
    git(c, "config", "user.email", `w${i}@chant.dev`);
    git(c, "config", "user.name", `Writer ${i}`);
    git(c, "config", "commit.gpgsign", "false");
    clones.push(c);
  }
  return { remote, clones };
}

const row: LockRow = { key: stackRowKey("shop", "staging"), target: "shop/staging", address: "shop/staging" };
const holder = (run: string, at = new Date()): LockRowHolder => ({ run, at: at.toISOString() });

/** The forge cannot be asked (no token), so only the hold's own token and age speak. */
const liveness = (clock: () => number) => forgeLockLiveness({}, (async () => ({ ok: false, json: async () => ({}) })) as never, clock);

const MIN = 60_000;

describe("a failed job", () => {
  test("lets go of its hold when its lease is released, so the next wave takes the row at once", async () => {
    const { clones: [a, b] } = writers(2);
    const first = await leaseLockRows("pr-apply", [row], { cwd: a, holder: holder("25"), beat: () => () => {} });
    expect(first.ok).toBe(true);
    expect((await readLockRows("pr-apply", { cwd: b })).rows).toEqual({ [row.key]: "25" });
    if (first.ok) expect(await first.lease.release()).toBe(true);
    expect((await readLockRows("pr-apply", { cwd: b })).rows).toEqual({});
    const next = await takeLockRows("pr-apply", [row], holder("31"), { cwd: b, alive: liveness(Date.now) });
    expect(next.ok).toBe(true);
  });

  test("the beat stops before the rows are let go", async () => {
    const { clones: [a] } = writers(1);
    const order: string[] = [];
    const first = await leaseLockRows("pr-apply", [row], { cwd: a, holder: holder("25"), beat: () => () => order.push("beat stopped") });
    if (!first.ok) throw new Error("not held");
    await first.lease.release();
    order.push("released");
    expect(order).toEqual(["beat stopped", "released"]);
  });
});

describe("a job that lost its lock push", () => {
  test("leaves no hold on the remote, so the next wave is not blocked", async () => {
    const { clones: [a, b] } = writers(2);
    // The push of chant/lifecycle from `a` cannot reach the remote.
    git(a, "remote", "set-url", "--push", "origin", join(tmpdir(), "chant-lock-live-no-such-remote"));
    await expect(leaseLockRows("pr-apply", [row], { cwd: a, holder: holder("25") })).rejects.toThrow();
    expect((await readLockRows("pr-apply", { cwd: b })).rows).toEqual({});
    const next = await takeLockRows("pr-apply", [row], holder("31"), { cwd: b, alive: liveness(Date.now) });
    expect(next.ok).toBe(true);
  });
});

describe("a job cancelled or killed with no cleanup", () => {
  test("its hold is taken over once its beat is older than CHANT_LOCK_BEAT_STALE, with no token for the forge", async () => {
    const { clones: [a, b] } = writers(2);
    const t0 = Date.now();
    // Run 26 took the row and beat once; then it was cancelled and never ran its cleanup.
    const dead = await takeLockRows("pr-apply", [row], holder("26", new Date(t0)), { cwd: a, alive: liveness(() => t0) });
    expect(dead.ok).toBe(true);
    expect(await beatLockRows("pr-apply", "26", new Date(t0 + MIN).toISOString(), { cwd: a })).toBe("held");

    // Nine minutes after the last beat the hold still blocks.
    const early = await takeLockRows("pr-apply", [row], holder("44"), { cwd: b, alive: liveness(() => t0 + 10 * MIN) });
    expect(early.ok).toBe(false);

    // Past ten minutes it is gone, and the next wave takes the row over.
    const late = await takeLockRows("pr-apply", [row], holder("44"), { cwd: b, alive: liveness(() => t0 + 12 * MIN) });
    expect(late.ok).toBe(true);
    if (late.ok) expect(late.tookOver.map((h) => h.run)).toEqual(["26"]);
    expect((await readLockRows("pr-apply", { cwd: b })).rows).toEqual({ [row.key]: "44" });
  });

  test("a queued wave waits no longer than the beat, then takes the row", async () => {
    const { clones: [a, b] } = writers(2);
    const t0 = Date.now();
    await takeLockRows("pr-apply", [row], holder("26", new Date(t0)), { cwd: a, alive: liveness(() => t0) });
    await beatLockRows("pr-apply", "26", new Date(t0).toISOString(), { cwd: a });
    let clock = t0 + 5 * MIN;
    const got = await waitLockRows(
      "pr-apply",
      [row],
      holder("44", new Date(clock)),
      {
        deadline: t0 + 60 * MIN,
        pollMs: MIN,
        now: () => clock,
        // Each pause is a minute on the test's clock.
        sleep: async (ms) => {
          clock += ms;
        },
      },
      { cwd: b, alive: liveness(() => clock) },
    );
    expect(got.ok).toBe(true);
    expect(got.tookOver.map((h) => h.run)).toEqual(["26"]);
    // It waited for the beat to go stale, about five more minutes, and not for the 60 minute deadline.
    expect(clock - t0).toBeLessThan(15 * MIN);
  });

  test("a queued run that stopped refreshing its entry does not hold up the waves behind it", async () => {
    const { clones: [a, b] } = writers(2);
    const t0 = Date.now();
    // Run 19 holds the row, and run 25 queues behind it with the older commit. Run 25 is then killed: its pause throws, so it never leaves the queue.
    await takeLockRows("pr-apply", [row], holder("19", new Date(t0 - 10 * MIN)), { cwd: a, alive: liveness(() => t0 - 10 * MIN) });
    await beatLockRows("pr-apply", "19", new Date(t0 - 10 * MIN).toISOString(), { cwd: a });
    await expect(
      waitLockRows(
        "pr-apply",
        [row],
        holder("25", new Date(t0 - 10 * MIN)),
        { deadline: t0 + 60 * MIN, commitAt: "2026-10-30T20:00:00Z", now: () => t0 - 10 * MIN, sleep: async () => Promise.reject(new Error("killed")) },
        { cwd: a, alive: liveness(() => t0 - 10 * MIN) },
      ),
    ).rejects.toThrow("killed");
    expect(Object.keys((await readLockRows("pr-apply", { cwd: b })).waiting ?? {})).toEqual(["25"]);
    // Run 19 finishes and lets go.
    await clearRunLockRows("pr-apply", "19", { cwd: a });

    const wave = (clock: number) =>
      waitLockRows(
        "pr-apply",
        [row],
        holder("31", new Date(clock)),
        { deadline: clock, commitAt: "2026-10-30T21:00:00Z", now: () => clock, sleep: async () => {} },
        { cwd: b, alive: liveness(() => clock) },
      );
    // A minute on, run 25 may still be alive and goes first.
    await expect(wave(t0 - 9 * MIN)).rejects.toThrow(/run 25/);
    // Ten minutes after its last refresh it is gone, and run 31 takes the row.
    const got = await wave(t0);
    expect(got.ok).toBe(true);
    expect((await readLockRows("pr-apply", { cwd: b })).rows).toEqual({ [row.key]: "31" });
  });
});

describe("a live job", () => {
  test("keeps blocking while its beat is fresh, even when its hold is older than the lease", async () => {
    const { clones: [a, b] } = writers(2);
    const t0 = Date.now();
    await takeLockRows("pr-apply", [row], holder("19", new Date(t0)), { cwd: a, alive: liveness(() => t0) });
    // Three hours on, an apply that still beats.
    const later = t0 + 3 * 3600_000;
    await beatLockRows("pr-apply", "19", new Date(later - MIN).toISOString(), { cwd: a });
    const blocked = await takeLockRows("pr-apply", [row], holder("31"), { cwd: b, alive: liveness(() => later) });
    expect(blocked.ok).toBe(false);
    if (!blocked.ok) expect(blocked.held.map((h) => h.holder.run)).toEqual(["19"]);
    expect((await readLockRows("pr-apply", { cwd: b })).rows).toEqual({ [row.key]: "19" });
  });

  test("a hold without a beat keeps the old rules: it blocks inside the lease", async () => {
    const { clones: [a, b] } = writers(2);
    const t0 = Date.now();
    await takeLockRows("pr-apply", [row], holder("19", new Date(t0)), { cwd: a, alive: liveness(() => t0) });
    const blocked = await takeLockRows("pr-apply", [row], holder("31"), { cwd: b, alive: liveness(() => t0 + 30 * MIN) });
    expect(blocked.ok).toBe(false);
  });

  test("a wait that gives up names the hold and the command that frees it", async () => {
    const { clones: [a, b] } = writers(2);
    const t0 = Date.now();
    await takeLockRows("pr-apply", [row], holder("19", new Date(t0)), { cwd: a, alive: liveness(() => t0) });
    await beatLockRows("pr-apply", "19", new Date(t0).toISOString(), { cwd: a });
    const got = await leaseLockRows("pr-apply", [row], {
      cwd: b,
      holder: holder("31"),
      alive: liveness(() => t0),
      wait: { deadline: t0, now: () => t0, sleep: async () => {} },
    });
    expect(got.ok).toBe(false);
    if (!got.ok) {
      expect(got.timedOut).toBe(true);
      expect(got.message).toContain("run 19");
      expect(got.message).toContain("last beat");
      expect(got.message).toContain("chant unlock --run <id> --gate pr-apply");
    }
  });
});

describe("a hold cleared by hand", () => {
  test("chant unlock --run frees the rows and the queue entry of a run, whatever its liveness", async () => {
    const { clones: [a, b] } = writers(2);
    await takeLockRows("pr-apply", [row], holder("26"), { cwd: a, alive: liveness(Date.now) });
    const cleared = await clearRunLockRows("pr-apply", "26", { cwd: b });
    expect(cleared.released).toEqual([row.key]);
    const now = await readLockRows("pr-apply", { cwd: a });
    expect(now.rows).toEqual({});
    expect(now.holders).toEqual({});
    // Nothing left to clear.
    expect((await clearRunLockRows("pr-apply", "26", { cwd: b })).released).toEqual([]);
  });
});

describe("the heartbeat loop", () => {
  const base = { gate: "pr-apply", run: "26", parent: 1, intervalMs: 60_000, sleep: async () => {}, now: () => 0 };

  test("beats until the hold is gone", async () => {
    let n = 0;
    const end = await runBeatLoop({ ...base, parentAlive: () => true, beat: async () => (++n < 3 ? "held" : "gone") });
    expect(end).toBe("released");
    expect(n).toBe(3);
  });

  test("ends with its parent process, and touches nothing after", async () => {
    let n = 0;
    let alive = true;
    const end = await runBeatLoop({
      ...base,
      parentAlive: () => alive,
      beat: async () => {
        if (++n === 2) alive = false;
        return "held";
      },
    });
    expect(end).toBe("parent-gone");
    expect(n).toBe(2);
  });

  test("a failed touch is tried again at the next interval", async () => {
    let n = 0;
    const lines: string[] = [];
    const end = await runBeatLoop({
      ...base,
      parentAlive: () => true,
      log: (l) => lines.push(l),
      beat: async () => {
        if (++n === 1) throw new Error("push refused");
        return "gone";
      },
    });
    expect(end).toBe("released");
    expect(lines[0]).toContain("push refused");
  });
});
