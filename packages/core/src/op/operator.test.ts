import { describe, test, expect } from "vitest";
import { withTestDir } from "@intentius/chant-test-utils";
import { spawnSync } from "node:child_process";
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { ActivityFn, ActivityProfile } from "./activity-registry";
import {
  discoverConvergeOps,
  runOperatorRound,
  runOperatorForever,
  formatRoundLine,
  DEFAULT_OPERATOR_INTERVAL_MS,
} from "./operator";
import { readLease } from "../lifecycle/lease";
import { appendConvergeRecord, readConvergeLedger } from "../lifecycle/converge-ledger";

const PROFILES: Record<string, ActivityProfile> = {};

function git(args: string[], cwd: string): { stdout: string; exitCode: number } {
  const r = spawnSync("git", args, { cwd, encoding: "utf-8" });
  return { stdout: r.stdout ?? "", exitCode: r.status ?? -1 };
}

async function initRepo(dir: string): Promise<void> {
  git(["init", "-q", "-b", "main"], dir);
  git(["config", "user.email", "test@chant.dev"], dir);
  git(["config", "user.name", "Test"], dir);
  writeFileSync(join(dir, "README.md"), "fixture\n");
  git(["add", "README.md"], dir);
  git(["commit", "-q", "-m", "init"], dir);
}

/**
 * Write a minimal fixture ConvergeOp — the same `{ props: OpConfig }` shape
 * `discoverOps` reads from a real `*.op.ts` file's default export
 * (`../op/discover.ts`), hand-built here rather than going through the real
 * `ConvergeOp()` composite (lexicons/temporal) so this suite tests the
 * operator's own discovery/lease/tick-loop logic without depending on that
 * lexicon at all. One "Converge" phase calling a single fake activity —
 * `runOpLocally` doesn't care what the phases are named or how many there
 * are, only that they run through the local executor.
 */
function writeFixtureConvergeOp(dir: string, opName: string, env: string): void {
  const opsDir = join(dir, "ops");
  mkdirSync(opsDir, { recursive: true });
  writeFileSync(
    join(opsDir, `${opName}.op.ts`),
    `export default {
  props: {
    name: ${JSON.stringify(opName)},
    overview: "fixture converge op",
    phases: [{ name: "Converge", steps: [{ kind: "activity", fn: "fakeTick", args: {} }] }],
    searchAttributes: { Converge: "true", Env: ${JSON.stringify(env)}, Dial: "observe" },
  },
};
`,
  );
}

function writeFixtureNonConvergeOp(dir: string, opName: string): void {
  const opsDir = join(dir, "ops");
  mkdirSync(opsDir, { recursive: true });
  writeFileSync(
    join(opsDir, `${opName}.op.ts`),
    `export default {
  props: {
    name: ${JSON.stringify(opName)},
    overview: "fixture ordinary op",
    phases: [{ name: "Deploy", steps: [{ kind: "activity", fn: "fakeTick", args: {} }] }],
  },
};
`,
  );
}

/** A fake `convergeTick`-shaped activity that appends a real converge-ledger record — so a round's ledger effect is observable through the public reader, the same as the real activity's I/O shape. */
function fakeTickActivities(dir: string, env: string, opName: string, opts?: { throws?: boolean }): Map<string, ActivityFn> {
  return new Map<string, ActivityFn>([
    [
      "fakeTick",
      async () => {
        if (opts?.throws) throw new Error("boom: simulated tick failure");
        await appendConvergeRecord(
          {
            op: opName,
            env,
            timestamp: new Date().toISOString(),
            firedRuleIds: [],
            outcomes: [],
            summary: { drifted: 0, remediated: 0, reported: 0, skippedBudget: 0, skippedFlap: 0, unobserved: 0, adopted: 0 },
            log: `converge(${env}): drifted=0 remediated=0 reported=0 skipped-budget=0 skipped-flap=0 unobserved=0 adopted=0`,
          },
          { cwd: dir },
        );
        return { ok: true };
      },
    ],
  ]);
}

describe("discoverConvergeOps", () => {
  test("finds only ops with searchAttributes.Converge === 'true'", async () => {
    await withTestDir(async (dir) => {
      await initRepo(dir);
      writeFixtureConvergeOp(dir, "staging-converge", "staging");
      writeFixtureNonConvergeOp(dir, "fountain-apply");

      const { ops, errors } = await discoverConvergeOps({ cwd: dir });
      expect(errors).toEqual([]);
      expect(ops.map((d) => d.config.name)).toEqual(["staging-converge"]);
    });
  });

  test("--env filters to ConvergeOps declaring that env", async () => {
    await withTestDir(async (dir) => {
      await initRepo(dir);
      writeFixtureConvergeOp(dir, "staging-converge", "staging");
      writeFixtureConvergeOp(dir, "prod-converge", "prod");

      const { ops } = await discoverConvergeOps({ cwd: dir, env: "prod" });
      expect(ops.map((d) => d.config.name)).toEqual(["prod-converge"]);
    });
  });

  test("no env filter discovers every ConvergeOp, sorted by name", async () => {
    await withTestDir(async (dir) => {
      await initRepo(dir);
      writeFixtureConvergeOp(dir, "staging-converge", "staging");
      writeFixtureConvergeOp(dir, "prod-converge", "prod");

      const { ops } = await discoverConvergeOps({ cwd: dir });
      expect(ops.map((d) => d.config.name)).toEqual(["prod-converge", "staging-converge"]);
    });
  });
});

describe("runOperatorRound — lease + tick execution over a fixture ConvergeOp (offline)", () => {
  test("acquires the lease, ticks, and records the tick as a ledger fact", async () => {
    await withTestDir(async (dir) => {
      await initRepo(dir);
      writeFixtureConvergeOp(dir, "staging-converge", "staging");
      const activities = fakeTickActivities(dir, "staging", "staging-converge");

      const events = await runOperatorRound({ cwd: dir, holder: "op-a", activities, profiles: PROFILES });
      expect(events).toEqual([{ kind: "ticked", op: "staging-converge", env: "staging", result: expect.objectContaining({ ok: true }) }]);

      const { records } = await readConvergeLedger("staging", { cwd: dir });
      expect(records).toHaveLength(1);
      expect(records[0].op).toBe("staging-converge");
    });
  });

  test("a second operator process (different holder) sees the lease held and skips — never queues", async () => {
    await withTestDir(async (dir) => {
      await initRepo(dir);
      writeFixtureConvergeOp(dir, "staging-converge", "staging");
      const activities = fakeTickActivities(dir, "staging", "staging-converge");

      // holder-a acquires and is (simulated as) still ticking — hold the
      // lease without releasing, by not letting a full round complete for it.
      const { acquireLease } = await import("../lifecycle/lease");
      await acquireLease("staging-converge", "holder-a", { cwd: dir, ttlMs: 60_000 });

      const events = await runOperatorRound({ cwd: dir, holder: "holder-b", activities, profiles: PROFILES });
      expect(events).toEqual([{ kind: "skipped-lease-held", op: "staging-converge", env: "staging", heldBy: "holder-a" }]);

      // Nothing ticked — no ledger record.
      const { records } = await readConvergeLedger("staging", { cwd: dir });
      expect(records).toHaveLength(0);
    });
  });

  test("a stale lease .lock file reports lease-error for that op — never a thrown exception out of the round, never misread as lease-held (#1959 finding 2)", async () => {
    await withTestDir(async (dir) => {
      await initRepo(dir);
      writeFixtureConvergeOp(dir, "staging-converge", "staging");
      const activities = fakeTickActivities(dir, "staging", "staging-converge");

      // A previous `chant operator` acquired the lease, then was killed
      // mid-renewal — its `.lock` file is still sitting there, blocking
      // every future write to this op's lease ref.
      const { acquireLease } = await import("../lifecycle/lease");
      await acquireLease("staging-converge", "holder-a", { cwd: dir, ttlMs: 60_000 });
      mkdirSync(join(dir, ".git", "refs", "chant", "lease"), { recursive: true });
      writeFileSync(join(dir, ".git", "refs", "chant", "lease", "staging-converge.lock"), "");

      // holder-a itself tries to renew next round — it owns the lease, so
      // acquireLease attempts the write and hits the lock file.
      const events = await runOperatorRound({ cwd: dir, holder: "holder-a", activities, profiles: PROFILES });
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ kind: "lease-error", op: "staging-converge", env: "staging" });
      expect((events[0] as { error: string }).error).toContain("staging-converge.lock");

      // Nothing ticked.
      const { records } = await readConvergeLedger("staging", { cwd: dir });
      expect(records).toHaveLength(0);
    });
  });

  test("a failing tick reports tick-failed, not a thrown exception out of the round", async () => {
    await withTestDir(async (dir) => {
      await initRepo(dir);
      writeFixtureConvergeOp(dir, "staging-converge", "staging");
      const activities = fakeTickActivities(dir, "staging", "staging-converge", { throws: true });

      const events = await runOperatorRound({ cwd: dir, holder: "op-a", activities, profiles: PROFILES });
      expect(events).toHaveLength(1);
      expect(events[0].kind).toBe("tick-failed");
    });
  });

  test("ticks every discovered ConvergeOp across environments in one round", async () => {
    await withTestDir(async (dir) => {
      await initRepo(dir);
      writeFixtureConvergeOp(dir, "staging-converge", "staging");
      writeFixtureConvergeOp(dir, "prod-converge", "prod");
      const activities = new Map<string, ActivityFn>([
        ...fakeTickActivities(dir, "staging", "staging-converge"),
      ]);
      // Both fixtures call the same "fakeTick" fn name; one shared fake that
      // reads env/op from the running Op's own config isn't available to an
      // ActivityFn (it only sees step args), so this test only asserts round
      // shape/coverage, not each op's own ledger content — that's covered by
      // the single-op test above.
      activities.set("fakeTick", async () => ({ ok: true }));

      const events = await runOperatorRound({ cwd: dir, holder: "op-a", activities, profiles: PROFILES });
      expect(events.map((e) => e.op).sort()).toEqual(["prod-converge", "staging-converge"]);
      expect(events.every((e) => e.kind === "ticked")).toBe(true);
    });
  });
});

describe("crash recovery — re-tick after a lease expires with no manual repair (#1485)", () => {
  test("holder A ticks, 'crashes' (never renews); after the TTL passes, holder B re-acquires and re-ticks — the ledger shows continuity, not a gap", async () => {
    await withTestDir(async (dir) => {
      await initRepo(dir);
      writeFixtureConvergeOp(dir, "staging-converge", "staging");
      const activities = fakeTickActivities(dir, "staging", "staging-converge");

      const t0 = new Date("2026-01-01T00:00:00.000Z");
      const round1 = await runOperatorRound({
        cwd: dir, holder: "operator-a", leaseTtlMs: 1_000, activities, profiles: PROFILES, now: () => t0,
      });
      expect(round1[0].kind).toBe("ticked");

      // operator-a crashes: no release, no renewal. A restarted process (a
      // new holder id, matching `currentHolderId()`'s per-process identity)
      // tries again after the lease's TTL has passed.
      const tAfterCrash = new Date("2026-01-01T00:00:05.000Z");
      const round2 = await runOperatorRound({
        cwd: dir, holder: "operator-a-restarted", leaseTtlMs: 1_000, activities, profiles: PROFILES, now: () => tAfterCrash,
      });
      expect(round2[0].kind).toBe("ticked");

      const { records } = await readConvergeLedger("staging", { cwd: dir });
      expect(records).toHaveLength(2);

      const { record: lease } = await readLease("staging-converge", { cwd: dir });
      expect(lease?.holder).toBe("operator-a-restarted");
    });
  });

  test("re-acquiring before the TTL passes still fails — a live operator isn't preempted by a phantom crash", async () => {
    await withTestDir(async (dir) => {
      await initRepo(dir);
      writeFixtureConvergeOp(dir, "staging-converge", "staging");
      const activities = fakeTickActivities(dir, "staging", "staging-converge");

      const t0 = new Date("2026-01-01T00:00:00.000Z");
      await runOperatorRound({ cwd: dir, holder: "operator-a", leaseTtlMs: 60_000, activities, profiles: PROFILES, now: () => t0 });

      const tSoonAfter = new Date("2026-01-01T00:00:05.000Z");
      const events = await runOperatorRound({
        cwd: dir, holder: "operator-b", leaseTtlMs: 60_000, activities, profiles: PROFILES, now: () => tSoonAfter,
      });
      expect(events[0].kind).toBe("skipped-lease-held");
    });
  });
});

describe("runOperatorForever — interval/timer behavior", () => {
  // `sleepAbortable` (operator.ts) is driven by real `setTimeout`, but each
  // round underneath it makes several *real* git subprocess calls (lease
  // read/acquire, ledger append) — genuine process I/O that fake timers
  // (`vi.useFakeTimers`) can't fast-forward through, only JS-scheduled
  // callbacks. So this exercises the actual interval/abort behavior over
  // real (small) wall-clock time instead: a short `intervalMs`, polling for
  // each expected round count with a generous bound, never a bare sleep.
  async function waitForRoundCount(rounds: unknown[], n: number, maxWaitMs = 5_000): Promise<void> {
    const deadline = Date.now() + maxWaitMs;
    while (rounds.length < n && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(rounds.length).toBeGreaterThanOrEqual(n);
  }

  test("runs a round immediately, then again every intervalMs, stopping on abort", async () => {
    await withTestDir(async (dir) => {
      await initRepo(dir);
      writeFixtureConvergeOp(dir, "staging-converge", "staging");
      const activities = fakeTickActivities(dir, "staging", "staging-converge");

      const controller = new AbortController();
      const rounds: number[] = [];
      const loop = runOperatorForever({
        cwd: dir,
        holder: "op-a",
        intervalMs: 40,
        activities,
        profiles: PROFILES,
        signal: controller.signal,
        onRound: () => rounds.push(Date.now()),
      });

      await waitForRoundCount(rounds, 1); // the immediate first round
      await waitForRoundCount(rounds, 3); // at least two more, ~40ms apart

      controller.abort();
      const countAtAbort = rounds.length;
      await new Promise((r) => setTimeout(r, 120)); // well past a couple more intervals, if any fired
      expect(rounds.length).toBe(countAtAbort); // no further round after abort

      await loop;
    });
  }, 10_000);

  test("default interval is used when none is given", () => {
    expect(DEFAULT_OPERATOR_INTERVAL_MS).toBeGreaterThan(0);
  });
});

describe("formatRoundLine", () => {
  test("renders each event kind as one line", () => {
    expect(formatRoundLine({ kind: "ticked", op: "x", env: "staging", result: { op: "x", records: [], totalMs: 1, ok: true } }))
      .toContain("ticked=1 ok=true");
    expect(formatRoundLine({ kind: "skipped-lease-held", op: "x", env: "staging", heldBy: "holder-a" }))
      .toContain("lease-held:holder-a");
    expect(formatRoundLine({ kind: "tick-failed", op: "x", env: "staging", error: "boom" }))
      .toContain('error="boom"');
    expect(formatRoundLine({ kind: "fenced", op: "x", env: "staging" }))
      .toContain("fenced=1");
    expect(formatRoundLine({ kind: "lease-error", op: "x", env: "staging", error: "stale lock at .../x.lock" }))
      .toContain("stale lock at .../x.lock");
  });
});
