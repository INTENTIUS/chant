import { describe, test, expect, vi } from "vitest";
import type { OpConfig } from "./types";
import type { ActivityFn, ActivityProfile } from "./activity-registry";
import {
  runOpLocally,
  parseDuration,
  findGate,
  LocalGateUnsupportedError,
  OpRunFailure,
} from "./local-executor";

// Fast profiles so retry/timeout tests run in milliseconds.
const PROFILES: Record<string, ActivityProfile> = {
  fastIdempotent: {
    startToCloseTimeout: "5m",
    retry: { maximumAttempts: 3, initialInterval: "5ms", backoffCoefficient: 2 },
  },
  quickTimeout: {
    startToCloseTimeout: "50ms",
    retry: { maximumAttempts: 2, initialInterval: "1ms", backoffCoefficient: 1 },
  },
  single: { startToCloseTimeout: "5m", retry: { maximumAttempts: 1 } },
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
    expect(result.ok).toBe(true);
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
    const profiles = { ...PROFILES, fastIdempotent: { startToCloseTimeout: "30ms", retry: { maximumAttempts: 1 } } };
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
        startToCloseTimeout: "5m",
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
  });
});

describe("runOpLocally — onFailure", () => {
  test("runs compensation phases in reverse and rejects with ok=false", async () => {
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
    expect(err.result.ok).toBe(false);
    // Main fails (3 attempts), then compensation runs in reverse: comp2, comp1.
    expect(order).toEqual(["main", "main", "main", "comp2", "comp1"]);
  });
});

describe("runOpLocally — gate rejection", () => {
  test("rejects before running any step when a gate is present", async () => {
    const ran = vi.fn();
    const activities = new Map<string, ActivityFn>([["a", async () => { ran(); }]]);
    const config = op({
      phases: [
        { name: "P", steps: [
          { kind: "activity", fn: "a" },
          { kind: "gate", signalName: "approve-prod" },
        ] },
      ],
    });
    await expect(runOpLocally(config, activities, PROFILES)).rejects.toBeInstanceOf(LocalGateUnsupportedError);
    await expect(runOpLocally(config, activities, PROFILES)).rejects.toThrow(/--temporal/);
    expect(ran).not.toHaveBeenCalled();
  });

  test("findGate locates a gate in phases or onFailure", () => {
    expect(findGate(op({ phases: [{ name: "P", steps: [{ kind: "activity", fn: "a" }] }] }))).toBeUndefined();
    const gated = findGate(op({
      phases: [{ name: "P", steps: [{ kind: "gate", signalName: "g" }] }],
    }));
    expect(gated?.signalName).toBe("g");
  });
});
