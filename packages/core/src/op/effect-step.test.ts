/**
 * effect() step + receipt store seam + local-executor semantics (#1834, epic
 * #1703). The contract under test:
 *
 * - the builder takes the typed EffectReceipt declaration only (no string
 *   form — enforced at the type level and at runtime);
 * - read-compare-run-write: a matching receipt skips the nested steps; a
 *   mismatch runs them and writes the receipt ONLY on their success, last;
 * - a nested-step failure leaves the receipt untouched (stale), so a rerun
 *   re-proposes the effect;
 * - `receiptStaleness` (WatchOp's phase) is read-only: it reports absent and
 *   differing receipts as findings and never writes.
 */
import { describe, test, expect } from "vitest";
import { EffectReceipt, receiptExpectation, EXISTENCE_EXPECTATION } from "../effect-receipt";
import { INTRINSIC_MARKER, type Intrinsic } from "../intrinsic";
import { effect, phase } from "./builders";
import {
  receiptActivities,
  receiptCheckInput,
  type ReceiptStore,
  type EffectReceiptRef,
} from "./receipt-store";
import type { ActivityFn, ActivityProfile } from "./activity-registry";
import type { OpConfig, ActivityStep } from "./types";
import { runOpLocally, findGate, LocalGateUnsupportedError, OpRunFailure } from "./local-executor";

function fakeIntrinsic(json: unknown): Intrinsic {
  return {
    [INTRINSIC_MARKER]: true,
    toJSON: () => json,
  };
}

const seeded = EffectReceipt("seeded", {
  effect: "db-seed",
  flavor: "hash",
  inputs: { file: "seed.sql", version: 3 },
});

const step = (fn: string, args?: Record<string, unknown>): ActivityStep => ({
  kind: "activity",
  fn,
  ...(args ? { args } : {}),
});

// ── Builder ───────────────────────────────────────────────────────────────────

describe("effect() builder", () => {
  test("wraps nested steps with the receipt's identity data and stamps a static expectation", () => {
    const s = effect(seeded, [step("shellCmd", { cmd: "npm run db:seed" })]);
    expect(s.kind).toBe("effect");
    expect(s.receipt).toEqual({
      name: "seeded",
      effect: "db-seed",
      flavor: "hash",
      inputs: { file: "seed.sql", version: 3 },
    });
    expect(s.expectation).toBe(receiptExpectation(seeded));
    expect(s.steps.map((n) => (n.kind === "activity" ? n.fn : n.signalName))).toEqual(["shellCmd"]);
  });

  test("existence receipts always get the constant expectation, reference inputs or not", () => {
    const r = EffectReceipt("booted", {
      effect: "bootstrap",
      flavor: "existence",
      inputs: { endpoint: fakeIntrinsic({ __attrRef: { entity: "Db", attribute: "endpoint" } }) },
    });
    expect(effect(r, []).expectation).toBe(EXISTENCE_EXPECTATION);
  });

  test("a hash receipt with reference inputs carries no synthesis-time expectation (resolves at run, #1703 decision 5)", () => {
    const r = EffectReceipt("migrated", {
      effect: "db-migrate",
      flavor: "hash",
      inputs: { endpoint: fakeIntrinsic({ __attrRef: { entity: "Db", attribute: "endpoint" } }) },
    });
    const s = effect(r, []);
    expect(s.expectation).toBeUndefined();
    expect("expectation" in s).toBe(false);
  });

  test("preserves authored order and nested gates", () => {
    const s = effect(seeded, [
      { kind: "gate", signalName: "approve-seed" },
      step("shellCmd", { cmd: "seed" }),
    ]);
    expect(s.steps.map((n) => n.kind)).toEqual(["gate", "activity"]);
  });

  test("refuses anything that is not the typed receipt declaration", () => {
    expect(() => effect({ name: "seeded" } as never, [])).toThrow(/no string form/);
    // Type level: a string receipt name must not compile.
    // @ts-expect-error — receipt is the EffectReceipt declaration, never a string
    expect(() => effect("seeded", [])).toThrow(/no string form/);
  });

  test("effect steps do not nest", () => {
    const inner = effect(seeded, []);
    expect(() => effect(seeded, [inner as never])).toThrow(/do not nest/);
  });
});

// ── Receipt store seam ────────────────────────────────────────────────────────

function memStore(initial?: Record<string, string>): {
  store: ReceiptStore;
  values: Map<string, string>;
  writes: Array<{ name: string; expectation: string }>;
} {
  const values = new Map(Object.entries(initial ?? {}));
  const writes: Array<{ name: string; expectation: string }> = [];
  const store: ReceiptStore = {
    async read(r: EffectReceiptRef) {
      return values.get(r.name);
    },
    async write(r: EffectReceiptRef, expectation: string) {
      writes.push({ name: r.name, expectation });
      values.set(r.name, expectation);
    },
  };
  return { store, values, writes };
}

describe("receiptActivities (the injectable store seam)", () => {
  const input = receiptCheckInput(seeded);
  const expected = receiptExpectation(seeded);

  test("receiptRead: absent receipt reads as current null, applied false", async () => {
    const { store } = memStore();
    const { receiptRead } = receiptActivities(store);
    expect(await receiptRead(input)).toEqual({ current: null, expectation: expected, applied: false });
  });

  test("receiptRead: matching receipt reads as applied true", async () => {
    const { store } = memStore({ seeded: expected });
    const { receiptRead } = receiptActivities(store);
    expect(await receiptRead(input)).toEqual({ current: expected, expectation: expected, applied: true });
  });

  test("receiptRead: refuses to invent an expectation for a reference-carrying hash receipt without a resolver", async () => {
    const r = EffectReceipt("migrated", {
      effect: "db-migrate",
      flavor: "hash",
      inputs: { endpoint: fakeIntrinsic("placeholder") },
    });
    const { store } = memStore();
    const { receiptRead } = receiptActivities(store);
    await expect(receiptRead(receiptCheckInput(r))).rejects.toThrow(/resolveExpectation/);
  });

  test("receiptWrite stores the expectation", async () => {
    const { store, writes, values } = memStore();
    const { receiptWrite } = receiptActivities(store);
    await receiptWrite({ receipt: input.receipt, expectation: expected });
    expect(writes).toEqual([{ name: "seeded", expectation: expected }]);
    expect(values.get("seeded")).toBe(expected);
  });

  test("receiptStaleness reports absent and differing receipts as findings, and never writes", async () => {
    const fresh = EffectReceipt("fresh", { effect: "e1", flavor: "hash", inputs: { v: 1 } });
    const differs = EffectReceipt("differs", { effect: "e2", flavor: "hash", inputs: { v: 2 } });
    const absent = EffectReceipt("absent", { effect: "e3", flavor: "existence" });
    const { store, writes } = memStore({
      fresh: receiptExpectation(fresh),
      differs: "sha256:stale",
    });
    const { receiptStaleness } = receiptActivities(store);
    const result = await receiptStaleness({
      receipts: [fresh, differs, absent].map(receiptCheckInput),
    });
    expect(result.stale).toBe(true);
    expect(result.findings).toEqual([
      { receipt: "differs", effect: "e2", kind: "differs", expected: receiptExpectation(differs), current: "sha256:stale" },
      { receipt: "absent", effect: "e3", kind: "absent", expected: EXISTENCE_EXPECTATION },
    ]);
    expect(writes).toEqual([]);
  });

  test("receiptStaleness with everything fresh reports stale false", async () => {
    const { store } = memStore({ seeded: expected });
    const { receiptStaleness } = receiptActivities(store);
    expect(await receiptStaleness({ receipts: [input] })).toEqual({ stale: false, findings: [] });
  });
});

// ── Local executor: read-compare-run-write ────────────────────────────────────

const PROFILES: Record<string, ActivityProfile> = {
  fastIdempotent: { startToCloseTimeout: "5m", retry: { maximumAttempts: 1 } },
};

function activityMap(
  store: ReceiptStore,
  extra: Record<string, ActivityFn>,
): Map<string, ActivityFn> {
  const map = new Map<string, ActivityFn>();
  for (const [name, fn] of Object.entries(receiptActivities(store))) {
    map.set(name, fn as unknown as ActivityFn);
  }
  for (const [name, fn] of Object.entries(extra)) map.set(name, fn);
  return map;
}

function seedOp(): OpConfig {
  return {
    name: "seed-op",
    overview: "",
    phases: [phase("Seed", [effect(seeded, [step("runSeed")])])],
  };
}

describe("runOpLocally — effect steps", () => {
  test("matching receipt skips the nested steps and writes nothing", async () => {
    const { store, writes } = memStore({ seeded: receiptExpectation(seeded) });
    const ran: string[] = [];
    const activities = activityMap(store, { runSeed: async () => void ran.push("runSeed") });
    const result = await runOpLocally(seedOp(), activities, PROFILES);
    expect(result.ok).toBe(true);
    expect(ran).toEqual([]);
    expect(writes).toEqual([]);
    // The read records the effect as already applied; the nested step is skipped.
    expect(result.records.map((r) => [r.fn, r.status])).toEqual([
      ["receiptRead", "ok"],
      ["runSeed", "skipped"],
    ]);
    expect(result.records[0].outcome).toEqual({ name: "EffectApplied", value: true });
  });

  test("mismatch runs the nested steps, then writes the receipt once, last", async () => {
    const { store, writes } = memStore();
    const order: string[] = [];
    const activities = activityMap(
      { read: store.read, write: async (r, e) => { order.push("write"); await store.write(r, e); } },
      { runSeed: async () => void order.push("runSeed") },
    );
    const result = await runOpLocally(seedOp(), activities, PROFILES);
    expect(result.ok).toBe(true);
    expect(order).toEqual(["runSeed", "write"]);
    expect(writes).toEqual([{ name: "seeded", expectation: receiptExpectation(seeded) }]);
    expect(result.records.map((r) => [r.fn, r.status])).toEqual([
      ["receiptRead", "ok"],
      ["runSeed", "ok"],
      ["receiptWrite", "ok"],
    ]);
  });

  test("a nested failure leaves the receipt untouched, and a rerun re-proposes the effect", async () => {
    const { store, writes, values } = memStore();
    let healthy = false;
    const activities = activityMap(store, {
      runSeed: async () => {
        if (!healthy) throw new Error("seed blew up");
      },
    });

    await expect(runOpLocally(seedOp(), activities, PROFILES)).rejects.toThrow(OpRunFailure);
    expect(writes).toEqual([]);
    expect(values.has("seeded")).toBe(false);

    // The receipt is stale, so the next run runs the effect again — and only
    // then writes.
    healthy = true;
    const rerun = await runOpLocally(seedOp(), activities, PROFILES);
    expect(rerun.ok).toBe(true);
    expect(writes).toEqual([{ name: "seeded", expectation: receiptExpectation(seeded) }]);
  });

  test("the failed run records the write as skipped, not run", async () => {
    const { store } = memStore();
    const activities = activityMap(store, {
      runSeed: async () => {
        throw new Error("boom");
      },
    });
    const failure = await runOpLocally(seedOp(), activities, PROFILES).catch((e: OpRunFailure) => e);
    expect(failure).toBeInstanceOf(OpRunFailure);
    expect((failure as OpRunFailure).result.records.map((r) => [r.fn, r.status])).toEqual([
      ["receiptRead", "ok"],
      ["runSeed", "fail"],
      ["receiptWrite", "skipped"],
    ]);
  });

  test("a gate nested in an effect step is rejected up front, like any other gate", () => {
    const config: OpConfig = {
      name: "gated",
      overview: "",
      phases: [
        phase("Seed", [effect(seeded, [{ kind: "gate", signalName: "approve-seed" }, step("runSeed")])]),
      ],
    };
    expect(findGate(config)?.signalName).toBe("approve-seed");
    const { store } = memStore();
    return expect(
      runOpLocally(config, activityMap(store, { runSeed: async () => {} }), PROFILES),
    ).rejects.toThrow(LocalGateUnsupportedError);
  });

  test("an effect step in a parallel phase is refused — read-compare-run-write is ordered", async () => {
    const config: OpConfig = {
      name: "par",
      overview: "",
      phases: [phase("P", [effect(seeded, [step("runSeed")])], { parallel: true })],
    };
    const { store } = memStore();
    await expect(
      runOpLocally(config, activityMap(store, { runSeed: async () => {} }), PROFILES),
    ).rejects.toThrow(/parallel phase/);
  });
});
