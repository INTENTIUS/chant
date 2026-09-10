import { describe, test, expect, vi } from "vitest";
import type { OpConfig } from "./types";
import type { ActivityFn, ActivityProfile } from "./activity-registry";
import {
  runOpLocally,
  parseDuration,
  OpRunFailure,
} from "./local-executor";
import { memoryGateLedgerPort, type GateLedgerPort } from "./gate";
import { computePlanDigest } from "../lifecycle/plan-digest";
import { renderHuman } from "./local-output";
import type { GateResolutionRecord, PendingGateRecord, PendingGateInput } from "../lifecycle/gate-ledger";
import { stepOutput } from "./step-output-ref";

// Fast profiles so retry/timeout tests run in milliseconds.
const PROFILES: Record<string, ActivityProfile> = {
  fastIdempotent: {
    timeout: "5m",
    retry: { maximumAttempts: 3, initialInterval: "5ms", backoffCoefficient: 2 },
  },
  quickTimeout: {
    timeout: "50ms",
    retry: { maximumAttempts: 2, initialInterval: "1ms", backoffCoefficient: 1 },
  },
  single: { timeout: "5m", retry: { maximumAttempts: 1 } },
};

function op(partial: Partial<OpConfig>): OpConfig {
  return { name: "test-op", overview: "", phases: [], ...partial };
}

describe("parseDuration", () => {
  test("parses single and compound durations", () => {
    expect(parseDuration("5m")).toBe(300_000);
    expect(parseDuration("30s")).toBe(30_000);
    expect(parseDuration("100ms")).toBe(100);
    expect(parseDuration("1h30m")).toBe(5_400_000);
    expect(parseDuration("48h")).toBe(172_800_000);
  });
  test("throws on garbage", () => {
    expect(() => parseDuration("soon")).toThrow(/unparseable/);
  });
});

describe("runOpLocally — sequencing", () => {
  test("runs phases and steps in declared order", async () => {
    const order: string[] = [];
    const make = (tag: string): ActivityFn => async () => { order.push(tag); };
    const activities = new Map<string, ActivityFn>([
      ["a", make("a")], ["b", make("b")], ["c", make("c")],
    ]);
    const config = op({
      phases: [
        { name: "P1", steps: [{ kind: "activity", fn: "a" }] },
        { name: "P2", steps: [{ kind: "activity", fn: "b" }] },
        { name: "P3", steps: [{ kind: "activity", fn: "c" }] },
      ],
    });
    const result = await runOpLocally(config, activities, PROFILES);
    expect(order).toEqual(["a", "b", "c"]);
    expect(result.status).toBe("ok");
    expect(result.records.map((r) => r.fn)).toEqual(["a", "b", "c"]);
  });

  test("parallel phase runs steps concurrently (~max, not sum)", async () => {
    const slow = (ms: number): ActivityFn => async () => { await new Promise((r) => setTimeout(r, ms)); };
    const activities = new Map<string, ActivityFn>([["s1", slow(60)], ["s2", slow(60)]]);
    const config = op({
      phases: [{ name: "P", parallel: true, steps: [
        { kind: "activity", fn: "s1" }, { kind: "activity", fn: "s2" },
      ] }],
    });
    const start = Date.now();
    await runOpLocally(config, activities, PROFILES);
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(110); // ~60 (max), well under 120 (sum)
  });
});

describe("runOpLocally — retry + timeout", () => {
  test("retries until success", async () => {
    let calls = 0;
    const flaky: ActivityFn = async () => {
      calls++;
      if (calls < 3) throw new Error("transient");
      return "ok";
    };
    const config = op({ phases: [{ name: "P", steps: [{ kind: "activity", fn: "flaky" }] }] });
    const result = await runOpLocally(config, new Map([["flaky", flaky]]), PROFILES);
    expect(calls).toBe(3);
    expect(result.records[0].status).toBe("ok");
  });

  test("times out a slow attempt and retries", async () => {
    let calls = 0;
    const slow: ActivityFn = async () => {
      calls++;
      // First attempt hangs past the 50ms timeout; second resolves fast.
      await new Promise((r) => setTimeout(r, calls === 1 ? 200 : 1));
    };
    // Map the default profile to quickTimeout (50ms timeout, 2 attempts).
    const config = op({
      phases: [{ name: "P", steps: [{ kind: "activity", fn: "slow" }] }],
    });
    const profiles = { ...PROFILES, fastIdempotent: PROFILES.quickTimeout };
    const result = await runOpLocally(config, new Map([["slow", slow]]), profiles);
    expect(calls).toBe(2);
    expect(result.records[0].status).toBe("ok");
  });

  test("rejects after exhausting retries", async () => {
    const always: ActivityFn = async () => { throw new Error("nope"); };
    const config = op({ phases: [{ name: "P", steps: [{ kind: "activity", fn: "always" }] }] });
    await expect(runOpLocally(config, new Map([["always", always]]), PROFILES)).rejects.toBeInstanceOf(OpRunFailure);
  });

  test("honors a step's non-default profile timeout (not the default)", async () => {
    // The default profile would time out at 50ms; the step is tagged longInfra,
    // which gives it room. Guards the bug where a profiled step silently got the
    // default cap (a per-runtime disagreement).
    const slow: ActivityFn = async () => { await new Promise((r) => setTimeout(r, 150)); return "done"; };
    const profiles = {
      fastIdempotent: { timeout: "50ms", retry: { maximumAttempts: 1 } },
      longInfra: { timeout: "5m", retry: { maximumAttempts: 1 } },
    };
    const config = op({
      phases: [{ name: "P", steps: [{ kind: "activity", fn: "slow", profile: "longInfra" }] }],
    });
    const result = await runOpLocally(config, new Map([["slow", slow]]), profiles);
    expect(result.records[0].status).toBe("ok");
  });
});

describe("runOpLocally — cancellation", () => {
  test("aborts the activity's signal on timeout", async () => {
    let abortedSeen = false;
    const hang: ActivityFn = async (_args, signal) => {
      await new Promise<void>((resolve) => {
        signal?.addEventListener("abort", () => { abortedSeen = true; resolve(); });
        setTimeout(resolve, 5000); // would hang far past the timeout if not aborted
      });
      throw new Error("abandoned");
    };
    const config = op({ phases: [{ name: "P", steps: [{ kind: "activity", fn: "hang" }] }] });
    const profiles = { ...PROFILES, fastIdempotent: { timeout: "30ms", retry: { maximumAttempts: 1 } } };
    await expect(runOpLocally(config, new Map([["hang", hang]]), profiles)).rejects.toBeInstanceOf(OpRunFailure);
    expect(abortedSeen).toBe(true);
  });

  test("stops retrying once the run signal aborts (Ctrl-C)", async () => {
    const controller = new AbortController();
    let calls = 0;
    const failOnAbort: ActivityFn = async () => {
      calls++;
      controller.abort(); // simulate SIGINT mid-attempt
      throw new Error("boom");
    };
    const config = op({ phases: [{ name: "P", steps: [{ kind: "activity", fn: "failOnAbort" }] }] });
    // fastIdempotent permits 3 attempts; the abort must cut it to 1.
    await expect(
      runOpLocally(config, new Map([["failOnAbort", failOnAbort]]), PROFILES, controller.signal),
    ).rejects.toBeInstanceOf(OpRunFailure);
    expect(calls).toBe(1);
  });

  test("skips onFailure compensation when aborted", async () => {
    const controller = new AbortController();
    const comp = vi.fn();
    const main: ActivityFn = async () => { controller.abort(); throw new Error("boom"); };
    const config = op({
      phases: [{ name: "Main", steps: [{ kind: "activity", fn: "main" }] }],
      onFailure: [{ name: "C", steps: [{ kind: "activity", fn: "comp" }] }],
    });
    const activities = new Map<string, ActivityFn>([["main", main], ["comp", async () => { comp(); }]]);
    await expect(runOpLocally(config, activities, PROFILES, controller.signal)).rejects.toBeInstanceOf(OpRunFailure);
    expect(comp).not.toHaveBeenCalled();
  });
});

describe("runOpLocally — non-retryable errors", () => {
  test("fails immediately on a non-retryable error type", async () => {
    let calls = 0;
    const fatal: ActivityFn = async () => {
      calls++;
      const e = new Error("bad manifest");
      e.name = "ValidationError";
      throw e;
    };
    const profiles = {
      ...PROFILES,
      fastIdempotent: {
        timeout: "5m",
        retry: { maximumAttempts: 3, initialInterval: "1ms", nonRetryableErrorTypes: ["ValidationError"] },
      },
    };
    const config = op({ phases: [{ name: "P", steps: [{ kind: "activity", fn: "fatal" }] }] });
    await expect(runOpLocally(config, new Map([["fatal", fatal]]), profiles)).rejects.toBeInstanceOf(OpRunFailure);
    expect(calls).toBe(1);
  });
});

describe("runOpLocally — outcomeAttribute", () => {
  test("captures a dot-path from the return value", async () => {
    const diff: ActivityFn = async () => ({ output: "...", exitCode: 0, drifted: false });
    const config = op({
      phases: [{ name: "Check", steps: [
        { kind: "activity", fn: "lifecycleDiff", outcomeAttribute: { name: "Drift", from: "drifted" } },
      ] }],
    });
    const result = await runOpLocally(config, new Map([["lifecycleDiff", diff]]), PROFILES);
    expect(result.records[0].outcome).toEqual({ name: "Drift", value: false });
    expect(result.records[0].outcomes).toEqual([{ name: "Drift", value: false }]);
  });

  test("an array captures every attribute off one result, and `outcome` stays the first (#2105)", async () => {
    const livePlan: ActivityFn = async () => ({ drift: true, unowned: 3, adoptable: 2 });
    const config = op({
      phases: [{ name: "Plan", steps: [
        { kind: "activity", fn: "choudoufuLivePlan", outcomeAttribute: [
          { name: "Drift", from: "drift" },
          { name: "Unowned", from: "unowned" },
          { name: "Adoptable", from: "adoptable" },
        ] },
      ] }],
    });
    const result = await runOpLocally(config, new Map([["choudoufuLivePlan", livePlan]]), PROFILES);
    expect(result.records[0].outcomes).toEqual([
      { name: "Drift", value: true },
      { name: "Unowned", value: 3 },
      { name: "Adoptable", value: 2 },
    ]);
    expect(result.records[0].outcome).toEqual({ name: "Drift", value: true });
  });

  test("a step with no attribute leaves both fields absent", async () => {
    const noop: ActivityFn = async () => ({ ok: true });
    const config = op({ phases: [{ name: "Plan", steps: [{ kind: "activity", fn: "noop" }] }] });
    const result = await runOpLocally(config, new Map([["noop", noop]]), PROFILES);
    expect(result.records[0].outcome).toBeUndefined();
    expect(result.records[0].outcomes).toBeUndefined();
  });
});

describe("runOpLocally — onFailure", () => {
  test("runs compensation phases in reverse and rejects with status=fail", async () => {
    const order: string[] = [];
    const make = (tag: string, fail = false): ActivityFn => async () => {
      order.push(tag);
      if (fail) throw new Error("boom");
    };
    const activities = new Map<string, ActivityFn>([
      ["main", make("main", true)],
      ["comp1", make("comp1")],
      ["comp2", make("comp2")],
    ]);
    const config = op({
      phases: [{ name: "Main", steps: [{ kind: "activity", fn: "main" }] }],
      onFailure: [
        { name: "C1", steps: [{ kind: "activity", fn: "comp1" }] },
        { name: "C2", steps: [{ kind: "activity", fn: "comp2" }] },
      ],
    });
    const err = await runOpLocally(config, activities, PROFILES).catch((e) => e);
    expect(err).toBeInstanceOf(OpRunFailure);
    expect(err.result.status).toBe("fail");
    // Main fails (3 attempts), then compensation runs in reverse: comp2, comp1.
    expect(order).toEqual(["main", "main", "main", "comp2", "comp1"]);
  });
});

describe("runOpLocally — gate as fact (#2119)", () => {
  const NOW = "2026-09-05T12:00:00.000Z";

  const resolution = (over: Partial<GateResolutionRecord> = {}): GateResolutionRecord => ({
    version: 1, op: "test-op", gate: "approve-prod", resolvedBy: "alex",
    timestamp: "2026-09-05T11:00:00.000Z", ...over,
  });
  const pending = (over: Partial<PendingGateRecord> = {}): PendingGateRecord => ({
    version: 1, kind: "pending", op: "test-op", gate: "approve-prod",
    timestamp: "2026-09-05T10:00:00.000Z", expiresAt: "2026-09-07T10:00:00.000Z", ...over,
  });

  /** A gate between two steps, so "no phase after the gate ran" is observable. */
  function gatedOp(): OpConfig {
    return op({
      phases: [
        { name: "P1", steps: [
          { kind: "activity", fn: "before" },
          { kind: "gate", gate: "approve-prod", description: "release manager signs off", timeout: "24h" },
          { kind: "activity", fn: "after" },
        ] },
        { name: "P2", steps: [{ kind: "activity", fn: "later" }] },
      ],
      onFailure: [{ name: "Comp", steps: [{ kind: "activity", fn: "compensate" }] }],
    });
  }

  function tracked() {
    const calls: string[] = [];
    const fn = (tag: string): ActivityFn => async () => { calls.push(tag); };
    return {
      calls,
      activities: new Map<string, ActivityFn>([
        ["before", fn("before")], ["after", fn("after")],
        ["later", fn("later")], ["compensate", fn("compensate")],
      ]),
    };
  }

  test("with no resolution: ends gated, records the pending fact, runs nothing after the gate", async () => {
    const { calls, activities } = tracked();
    const port = memoryGateLedgerPort();
    const result = await runOpLocally(gatedOp(), activities, PROFILES, undefined, { gates: port, now: NOW });

    expect(result.status).toBe("gated");
    expect(calls).toEqual(["before"]);
    expect(result.gate).toMatchObject({ op: "test-op", gate: "approve-prod", description: "release manager signs off" });
    // The gate's own `timeout` is the pending fact's expiry.
    expect(result.gate?.expiresAt).toBe("2026-09-06T12:00:00.000Z");
    expect(port.appended).toHaveLength(1);
    expect(result.records.map((r) => [r.fn, r.status])).toEqual([
      ["before", "ok"],
      ["gate:approve-prod", "skipped"],
      ["after", "skipped"],
      ["later", "skipped"],
    ]);
  });

  // #2310: the gate still ends the run `gated` — an append that only reaches
  // the local branch is still a correct local answer, and the #2309 author
  // was right that this must not become a failure. But the run used to say
  // nothing at all about the rejected push; now it does.
  test("a pending fact whose push was rejected still ends the run gated, and says the push failed", async () => {
    const { calls, activities } = tracked();
    const port = {
      async read() {
        return { resolutions: [] as GateResolutionRecord[], pending: [] as PendingGateRecord[] };
      },
      async appendPending(input: PendingGateInput) {
        return {
          record: { version: 1 as const, kind: "pending" as const, ...input },
          pushed: false,
          pushWarning: "chant/lifecycle remote branch has moved since this run started",
        };
      },
    };
    const result = await runOpLocally(gatedOp(), activities, PROFILES, undefined, { gates: port, now: NOW });

    expect(result.status).toBe("gated");
    expect(calls).toEqual(["before"]);
    expect(result.gate).toMatchObject({ op: "test-op", gate: "approve-prod" });
    expect(result.gatePushed).toBe(false);
    expect(result.gatePushWarning).toBe("chant/lifecycle remote branch has moved since this run started");
  });

  // #2202: the gate step's name key is `gate`; `signalName` is read through
  // 0.59.0, so a step still spelling it that way reaches the same ledger entry.
  test("a gate step still using the deprecated `signalName` key names the same gate", async () => {
    const { activities } = tracked();
    const legacy = op({
      phases: [{ name: "P1", steps: [{ kind: "gate", signalName: "approve-prod" }] }],
    });
    const port = memoryGateLedgerPort();
    const result = await runOpLocally(legacy, activities, PROFILES, undefined, { gates: port, now: NOW });

    expect(result.status).toBe("gated");
    expect(result.gate).toMatchObject({ op: "test-op", gate: "approve-prod" });
    expect(result.records.map((r) => r.fn)).toEqual(["gate:approve-prod"]);
  });

  test("onFailure phases do not run on a gated run", async () => {
    const { calls, activities } = tracked();
    await runOpLocally(gatedOp(), activities, PROFILES, undefined, { gates: memoryGateLedgerPort(), now: NOW });
    expect(calls).not.toContain("compensate");
  });

  test("a resolution newer than the pending fact passes the gate and carries the approver", async () => {
    const { calls, activities } = tracked();
    const port = memoryGateLedgerPort({
      pending: [pending()],
      resolutions: [resolution({ url: "https://github.com/org/repo/pull/7" })],
    });
    const result = await runOpLocally(gatedOp(), activities, PROFILES, undefined, { gates: port, now: NOW });

    expect(result.status).toBe("ok");
    expect(calls).toEqual(["before", "after", "later"]);
    expect(result.records.find((r) => r.fn === "gate:approve-prod")?.approval).toEqual({
      gate: "approve-prod",
      resolvedBy: "alex",
      timestamp: "2026-09-05T11:00:00.000Z",
      url: "https://github.com/org/repo/pull/7",
    });
    expect(port.appended).toHaveLength(0);
  });

  test("a resolution dated before the pending fact is ignored", async () => {
    const port = memoryGateLedgerPort({
      pending: [pending({ timestamp: "2026-09-05T11:30:00.000Z" })],
      resolutions: [resolution({ timestamp: "2026-09-05T09:00:00.000Z" })],
    });
    const result = await runOpLocally(gatedOp(), tracked().activities, PROFILES, undefined, { gates: port, now: NOW });
    expect(result.status).toBe("gated");
  });

  test("a live pending fact is reused, not re-recorded", async () => {
    const port = memoryGateLedgerPort({ pending: [pending()] });
    const result = await runOpLocally(gatedOp(), tracked().activities, PROFILES, undefined, { gates: port, now: NOW });
    expect(result.status).toBe("gated");
    expect(port.appended).toHaveLength(0);
    expect(result.gate?.timestamp).toBe("2026-09-05T10:00:00.000Z");
  });

  test("an expired pending fact is ignored and re-recorded", async () => {
    const port = memoryGateLedgerPort({ pending: [pending({ expiresAt: "2026-09-05T11:00:00.000Z" })] });
    const result = await runOpLocally(gatedOp(), tracked().activities, PROFILES, undefined, { gates: port, now: NOW });
    expect(result.status).toBe("gated");
    expect(port.appended).toHaveLength(1);
    expect(result.gate?.timestamp).toBe(NOW);
  });

  test("approve then re-run completes the op", async () => {
    const port = memoryGateLedgerPort();
    const first = await runOpLocally(gatedOp(), tracked().activities, PROFILES, undefined, { gates: port, now: NOW });
    expect(first.status).toBe("gated");

    // `chant approve` writes the counterpart fact, dated after the pending one.
    const approved = memoryGateLedgerPort({
      pending: [first.gate!],
      resolutions: [resolution({ timestamp: "2026-09-05T12:30:00.000Z" })],
    });
    const second = await runOpLocally(gatedOp(), tracked().activities, PROFILES, undefined, {
      gates: approved,
      now: "2026-09-05T13:00:00.000Z",
    });
    expect(second.status).toBe("ok");
  });
});

describe("runOpLocally — step-output references (#1290)", () => {
  test("a later step receives the producer's resolved value, not the placeholder", async () => {
    const received: unknown[] = [];
    const activities = new Map<string, ActivityFn>([
      ["produce", async () => ({ driftedStacks: ["a", "b"], count: 2 })],
      ["consume", async (args) => { received.push(args); }],
    ]);
    const config = op({
      phases: [{ name: "P", steps: [
        { kind: "activity", fn: "produce", id: "diff" },
        { kind: "activity", fn: "consume", args: { stacks: stepOutput("diff", "driftedStacks") } },
      ] }],
    });
    const result = await runOpLocally(config, activities, PROFILES);
    expect(result.status).toBe("ok");
    expect(received).toEqual([{ stacks: ["a", "b"] }]);
    // The recorded step also shows the resolved value, not the raw ref object.
    expect(result.records[1].args).toEqual({ stacks: ["a", "b"] });
  });

  test("a whole-value reference (no path) passes the entire producer result", async () => {
    const received: unknown[] = [];
    const activities = new Map<string, ActivityFn>([
      ["produce", async () => ({ ok: true, detail: "x" })],
      ["consume", async (args) => { received.push(args); }],
    ]);
    const config = op({
      phases: [{ name: "P", steps: [
        { kind: "activity", fn: "produce", id: "p" },
        { kind: "activity", fn: "consume", args: { result: stepOutput("p") } },
      ] }],
    });
    await runOpLocally(config, activities, PROFILES);
    expect(received).toEqual([{ result: { ok: true, detail: "x" } }]);
  });

  test("resolves a reference nested inside an object and an array", async () => {
    const received: unknown[] = [];
    const activities = new Map<string, ActivityFn>([
      ["produce", async () => ({ name: "prod" })],
      ["consume", async (args) => { received.push(args); }],
    ]);
    const config = op({
      phases: [{ name: "P", steps: [
        { kind: "activity", fn: "produce", id: "p" },
        {
          kind: "activity",
          fn: "consume",
          args: { config: { tags: ["static", stepOutput("p", "name")] } },
        },
      ] }],
    });
    await runOpLocally(config, activities, PROFILES);
    expect(received).toEqual([{ config: { tags: ["static", "prod"] } }]);
  });

  test("an unresolvable path resolves to undefined instead of throwing", async () => {
    const received: unknown[] = [];
    const activities = new Map<string, ActivityFn>([
      ["produce", async () => ({})],
      ["consume", async (args) => { received.push(args); }],
    ]);
    const config = op({
      phases: [{ name: "P", steps: [
        { kind: "activity", fn: "produce", id: "p" },
        { kind: "activity", fn: "consume", args: { v: stepOutput("p", "a.b") } },
      ] }],
    });
    const result = await runOpLocally(config, activities, PROFILES);
    expect(result.status).toBe("ok");
    expect(received).toEqual([{ v: undefined }]);
  });

  test("e2e: chant run on the local runtime, end to end — producer object flows to consumer", async () => {
    const activities = new Map<string, ActivityFn>([
      ["lifecycleDiff", async () => ({ driftedStacks: ["stack-a"], drifted: true })],
      ["applyStacks", async (args) => ({ applied: args.stacks })],
    ]);
    const config = op({
      phases: [
        { name: "Diff", steps: [{ kind: "activity", fn: "lifecycleDiff", id: "diff", args: { env: "prod" } }] },
        { name: "Apply", steps: [{ kind: "activity", fn: "applyStacks", args: { stacks: stepOutput("diff", "driftedStacks") } }] },
      ],
    });
    const result = await runOpLocally(config, activities, PROFILES);
    expect(result.status).toBe("ok");
    expect(result.records.every((r) => r.status === "ok")).toBe(true);
    expect(result.records[1].args).toEqual({ stacks: ["stack-a"] });
  });
});

/**
 * #2301 deliverable 2. The reported symptom was a whole apply that printed
 * `Op "live-apply" failed after 43.8s` and nothing else — no error line, no
 * failing step — because the gate's ledger write threw a plain `Error` and
 * the executor's catch only ever unpacked `PhaseFailure` and `GateStop`.
 * Everything else was built into an `OpRunFailure` and never read again.
 *
 * These assert the two halves separately: the gate step now produces a
 * failing record like any other step, and the outer catch no longer drops an
 * error it does not recognise. The second is the general one — the gate is
 * where it was found, not the only place it bites.
 */
describe("runOpLocally — a failure inside the run says what it was (#2301)", () => {
  const NOW = "2026-09-05T12:00:00.000Z";
  const LEDGER_ERROR =
    "cannot write _gates/live-apply.jsonl on the chant/lifecycle branch: " +
    "git commit-tree failed: fatal: unable to auto-detect email address (got 'runner@runner.(none)')";

  /** A gate ledger whose append fails the way a CI checkout with no git identity does. */
  function unwritablePort(message = LEDGER_ERROR) {
    return {
      async read() {
        return { resolutions: [] as GateResolutionRecord[], pending: [] as PendingGateRecord[] };
      },
      async appendPending(): Promise<never> {
        throw new Error(message);
      },
    };
  }

  function gateOnly(): OpConfig {
    return op({
      phases: [
        { name: "Plan", steps: [{ kind: "activity", fn: "plan" }] },
        { name: "Gate", steps: [{ kind: "gate", gate: "approve-live-apply" }] },
        { name: "Apply", steps: [{ kind: "activity", fn: "apply" }] },
      ],
    });
  }

  const noopActivities = new Map<string, ActivityFn>([
    ["plan", async () => undefined],
    ["apply", async () => undefined],
  ]);

  test("a gate whose ledger write fails is a failing step carrying the cause", async () => {
    const err = await runOpLocally(gateOnly(), noopActivities, PROFILES, undefined, {
      gates: unwritablePort(),
      now: NOW,
    }).then(() => undefined, (e: unknown) => e);

    expect(err).toBeInstanceOf(OpRunFailure);
    const { result } = err as OpRunFailure;
    expect(result.status).toBe("fail");

    const gateRecord = result.records.find((r) => r.fn === "gate:approve-live-apply");
    expect(gateRecord?.status).toBe("fail");
    expect(gateRecord?.error).toBe(LEDGER_ERROR);

    // The run stops at the gate, exactly as a failing activity stops its
    // phase — the Apply phase never starts.
    expect(result.records.map((r) => [r.fn, r.status])).toEqual([
      ["plan", "ok"],
      ["gate:approve-live-apply", "fail"],
    ]);
  });

  test("the rendered output names the cause instead of a bare failure line", async () => {
    const err = await runOpLocally(gateOnly(), noopActivities, PROFILES, undefined, {
      gates: unwritablePort(),
      now: NOW,
    }).then(() => undefined, (e: unknown) => e);

    const lines: string[] = [];
    renderHuman((err as OpRunFailure).result, (line) => lines.push(line));

    expect(lines).toContain(`    ${LEDGER_ERROR}`);
    expect(lines.at(-1)).toMatch(/^Op "test-op" failed after /);
    // The whole point: the failing step is visible, so the last line is no
    // longer the only line about the failure.
    expect(lines.some((l) => l.startsWith("  ✗ gate:approve-live-apply"))).toBe(true);
  });

  test("an error the executor does not recognise is recorded rather than dropped", async () => {
    // Neither a step's own failure nor a gate: the caller's progress callback
    // throws, which unwinds the phase loop as a plain `Error`. Before #2301
    // that produced an `OpRunFailure` whose `records` held nothing marked
    // failed and nothing carrying a message — a run that failed and said
    // nothing at all about why. The gate is where this was found, not the
    // only thing it swallowed.
    const config = op({ phases: [{ name: "P", steps: [{ kind: "activity", fn: "plan" }] }] });

    const err = await runOpLocally(config, noopActivities, PROFILES, undefined, {
      onRecord: () => {
        throw new Error("progress sink exploded");
      },
    }).then(() => undefined, (e: unknown) => e);

    expect(err).toBeInstanceOf(OpRunFailure);
    const failure = err as OpRunFailure;
    expect(failure.result.records).toHaveLength(1);
    expect(failure.result.records[0]).toMatchObject({
      status: "fail",
      error: expect.stringContaining("progress sink exploded"),
    });
    // The original error object is still reachable for a programmatic caller.
    expect((failure.cause as Error).message).toMatch(/progress sink exploded/);

    const lines: string[] = [];
    renderHuman(failure.result, (line) => lines.push(line));
    expect(lines.some((l) => l.includes("progress sink exploded"))).toBe(true);
  });
});

/**
 * #2300, measured on INTENTIUS/choudoufu#1026.
 *
 * The exact sequence that issue ran against a floci-backed root: `chant run
 * live-apply` returns `gated`, `chant approve` writes the resolution, a
 * resource in the root is renamed, and `chant run live-apply` runs again. It
 * applied, with no refusal, because the resolution carried the op, the gate,
 * the approver and a timestamp — and nothing about the plan. The approval had
 * authorised the next run rather than the plan its approver read.
 *
 * These drive the same four steps through the executor, with a Plan phase
 * whose digest moves when the root does.
 */
describe("runOpLocally — a gate approves a plan, not the next run (#2300)", () => {
  const NOW = "2026-09-09T12:00:00.000Z";

  /**
   * A gate ledger a test can approve against, which `memoryGateLedgerPort`
   * cannot: `chant approve` appends a resolution *between* two runs, and the
   * shared port has to carry it into the second one.
   */
  function approvableLedger(): GateLedgerPort & {
    approve(gate: string, planDigest: string | undefined, at: string): void;
    pending: PendingGateRecord[];
  } {
    const resolutions: GateResolutionRecord[] = [];
    const pending: PendingGateRecord[] = [];
    return {
      pending,
      approve(gate, planDigest, at) {
        resolutions.push({
          version: 1, op: "live-apply", gate, resolvedBy: "alex", timestamp: at,
          ...(planDigest !== undefined ? { planDigest } : {}),
        });
      },
      async read() {
        return { resolutions: [...resolutions], pending: [...pending] };
      },
      async appendPending(input) {
        const record: PendingGateRecord = { version: 1, kind: "pending", ...input };
        pending.push(record);
        // No remote in an in-memory ledger — nothing to fail to reach (#2310).
        return { record, pushed: true };
      },
    };
  }

  /**
   * The root under test, and the Op over it. `terraformPlan` digests whatever
   * `root.address` currently is, so renaming a resource between runs is one
   * assignment — the test's stand-in for editing the `.tf` file.
   */
  function harness() {
    const root = { address: "aws_s3_bucket.original" };
    const applied: string[] = [];
    const activities = new Map<string, ActivityFn>([
      ["terraformPlan", async () => ({
        planFile: "chant.tfplan",
        planDigest: computePlanDigest("terraform-plan", { resourceChanges: [{ address: root.address }] }),
      })],
      ["terraformApply", async (args) => {
        applied.push(String(args.planFile));
        return { applied: true };
      }],
    ]);
    const config = op({
      name: "live-apply",
      phases: [
        { name: "Plan", steps: [{ kind: "activity", fn: "terraformPlan", id: "plan", args: { root: "app" } }] },
        {
          name: "Gate",
          steps: [{ kind: "gate", gate: "approve-live-apply", plan: stepOutput("plan", "planDigest") }],
        },
        {
          name: "Apply",
          steps: [{ kind: "activity", fn: "terraformApply", args: { planFile: stepOutput("plan", "planFile") } }],
        },
      ],
    });
    const digestOf = (address: string) =>
      computePlanDigest("terraform-plan", { resourceChanges: [{ address }] });
    return { root, applied, activities, config, digestOf };
  }

  test("approve, rename a resource in the root, re-run — the Apply phase refuses, naming both digests", async () => {
    const { root, applied, activities, config, digestOf } = harness();
    const gates = approvableLedger();

    // 1. `chant run live-apply` — gated, and the pending fact names the plan.
    const first = await runOpLocally(config, activities, PROFILES, undefined, { gates, now: NOW });
    expect(first.status).toBe("gated");
    expect(first.gate?.planDigest).toBe(digestOf("aws_s3_bucket.original"));
    expect(applied).toEqual([]);

    // 2. `chant approve live-apply approve-live-apply` — for the plan above.
    gates.approve("approve-live-apply", digestOf("aws_s3_bucket.original"), "2026-09-09T12:05:00.000Z");

    // 3. A resource in the root is renamed.
    root.address = "aws_s3_bucket.renamed";

    // 4. `chant run live-apply` again. On the pre-#2300 rule this applied.
    const second = await runOpLocally(config, activities, PROFILES, undefined, {
      gates, now: "2026-09-09T12:10:00.000Z",
    });

    expect(second.status).toBe("gated");
    expect(applied).toEqual([]);

    const gateRecord = second.records.find((r) => r.fn === "gate:approve-live-apply");
    expect(gateRecord?.refusal).toContain(`approved: ${digestOf("aws_s3_bucket.original")}`);
    expect(gateRecord?.refusal).toContain(`planned: ${digestOf("aws_s3_bucket.renamed")}`);
    expect(gateRecord?.refusal).toContain("chant approve live-apply approve-live-apply");
    expect(gateRecord?.refusal).toContain("changed between that approval and this plan");
    // The Apply step never ran, and says so.
    expect(second.records.find((r) => r.fn === "terraformApply")?.status).toBe("skipped");

    // The refusal reaches a reader, not just the record.
    const lines: string[] = [];
    renderHuman(second, (line) => lines.push(line));
    expect(lines.some((l) => l.includes("[refused]") && l.includes("not for this plan"))).toBe(true);
  });

  test("approve, re-run with the root unchanged — it applies", async () => {
    const { applied, activities, config, digestOf } = harness();
    const gates = approvableLedger();

    expect((await runOpLocally(config, activities, PROFILES, undefined, { gates, now: NOW })).status).toBe("gated");
    gates.approve("approve-live-apply", digestOf("aws_s3_bucket.original"), "2026-09-09T12:05:00.000Z");

    const second = await runOpLocally(config, activities, PROFILES, undefined, {
      gates, now: "2026-09-09T12:10:00.000Z",
    });

    expect(second.status).toBe("ok");
    expect(applied).toEqual(["chant.tfplan"]);
    expect(second.records.find((r) => r.fn === "gate:approve-live-apply")?.approval?.resolvedBy).toBe("alex");
  });

  /**
   * The migration (#2300). Every resolution written before this change has no
   * `planDigest` at all, and the safe reading is that it matches nothing: such
   * a record proves someone approved something and nothing about what.
   * Accepting it once — the other candidate reading — would apply exactly the
   * unreviewed change this check exists to catch, on the estates that have
   * been running longest.
   */
  test("a resolution recorded before plan-bound gates does not pass, and the refusal says so", async () => {
    const { applied, activities, config, digestOf } = harness();
    const gates = approvableLedger();

    expect((await runOpLocally(config, activities, PROFILES, undefined, { gates, now: NOW })).status).toBe("gated");
    // A pre-#2300 resolution: newer than the pending fact, no plan on it.
    gates.approve("approve-live-apply", undefined, "2026-09-09T12:05:00.000Z");

    const second = await runOpLocally(config, activities, PROFILES, undefined, {
      gates, now: "2026-09-09T12:10:00.000Z",
    });

    expect(second.status).toBe("gated");
    expect(applied).toEqual([]);
    const gateRecord = second.records.find((r) => r.fn === "gate:approve-live-apply");
    expect(gateRecord?.refusal).toContain("approved: (none — recorded before plan-bound gates)");
    expect(gateRecord?.refusal).toContain(`planned: ${digestOf("aws_s3_bucket.original")}`);
    // ...and says why, which is not "something changed": nothing is known to
    // have changed, the record just never said what it approved.
    expect(gateRecord?.refusal).toContain("records no plan at all");
  });

  /**
   * A gate with no `plan` is every gate that existed before #2300 — a
   * component gate, an authored `gate()` with nothing to bind. Those decide
   * exactly as they did: newest resolution since the pending fact wins.
   */
  test("a gate that binds no plan is unchanged", async () => {
    const activities = new Map<string, ActivityFn>([["deploy", async () => ({ ok: true })]]);
    const config = op({
      name: "live-apply",
      phases: [
        { name: "Gate", steps: [{ kind: "gate", gate: "approve-live-apply" }] },
        { name: "Deploy", steps: [{ kind: "activity", fn: "deploy" }] },
      ],
    });
    const gates = approvableLedger();

    expect((await runOpLocally(config, activities, PROFILES, undefined, { gates, now: NOW })).status).toBe("gated");
    expect(gates.pending[0].planDigest).toBeUndefined();
    gates.approve("approve-live-apply", undefined, "2026-09-09T12:05:00.000Z");

    const second = await runOpLocally(config, activities, PROFILES, undefined, {
      gates, now: "2026-09-09T12:10:00.000Z",
    });
    expect(second.status).toBe("ok");
  });
});
