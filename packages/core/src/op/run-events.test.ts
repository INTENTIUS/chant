/**
 * #4041: the local executor's run-event stream (`chant run <op>
 * --events-json`). Every line passes the schema; each step's start comes
 * before its settle under the same step id; and the cases an old
 * `StepRecord` could not tell apart come out as `gated`, `skip: "receipt"`
 * and `skip: "not-run"`.
 */

import { describe, expect, test, vi } from "vitest";
import type { ActivityFn, ActivityProfile } from "./activity-registry";
import type { OpConfig } from "./types";
import { OpRunFailure, runOpLocally, type RunOpOptions } from "./local-executor";
import { memoryGateLedgerPort } from "./gate";
import { receiptActivities, type ReceiptStore } from "./receipt-store";
import { EffectReceipt, receiptExpectation } from "../effect-receipt";
import { effect } from "./builders";
import type { RunEvent } from "../run-event";
import { checkRunEventLines, stepKey, stepTrail } from "../workspace/__fixtures__/run-event-check";

vi.mock("./gate", async () => {
  const actual = await vi.importActual<typeof import("./gate")>("./gate");
  return { ...actual, gateIsSealed: async () => false };
});

const PROFILES: Record<string, ActivityProfile> = { fastIdempotent: { timeout: "5m", retry: { maximumAttempts: 1 } } };
const NOW = "2026-10-16T12:00:00.000Z";
const SHA = "0123456789abcdef0123456789abcdef01234567";

const op = (partial: Partial<OpConfig>): OpConfig => ({ name: "deploy-api", overview: "", phases: [], ...partial });
const ok: ActivityFn = async () => ({ done: true });

/** Run an Op with its events captured, settling whether it resolves or rejects. */
async function run(config: OpConfig, activities: Map<string, ActivityFn>, options: RunOpOptions = {}) {
  const lines: string[] = [];
  let status: string;
  try {
    status = (await runOpLocally(config, activities, PROFILES, undefined, {
      gates: memoryGateLedgerPort(),
      now: NOW,
      runId: "local-1",
      commit: SHA,
      runEvents: { write: (l) => lines.push(l) },
      ...options,
    })).status;
  } catch (err) {
    if (!(err instanceof OpRunFailure)) throw err;
    status = err.result.status;
  }
  return { status, events: checkRunEventLines(lines) };
}

describe("the local runtime's run events", () => {
  test("a run that passes: run, phases and steps, each step started before it settles, named as the run record names it", async () => {
    const { status, events } = await run(
      op({ phases: [{ name: "Build", steps: [{ kind: "activity", fn: "make" }] }, { name: "Ship", steps: [{ kind: "activity", fn: "push" }] }] }),
      new Map([["make", ok], ["push", ok]]),
    );
    expect(status).toBe("ok");
    // In a CI job the run keeps its own id and names the CI run as its origin, as its run record does (#4020).
    const ci = Boolean(process.env.GITHUB_RUN_ID || process.env.CI_PIPELINE_ID);
    expect(events[0]).toMatchObject({ runId: "local-1", kind: "op", name: "deploy-api", gitSha: SHA, runtime: ci ? "ci" : "local" });
    expect(events[0]!.runOrigin.forge).toBe(process.env.GITHUB_RUN_ID ? "github" : process.env.CI_PIPELINE_ID ? "gitlab" : "local");
    expect(events.map((e) => e.type)).toEqual([
      "run-start",
      "phase-start", "step-start", "step-settle", "phase-settle",
      "phase-start", "step-start", "step-settle", "phase-settle",
      "run-settle",
    ]);
    expect(events.at(-1)).toMatchObject({ status: "ok" });
  });

  test("a step's start is emitted before its settle, with the same step id", async () => {
    const { events } = await run(
      op({ phases: [{ name: "Build", steps: [{ kind: "activity", fn: "make" }, { kind: "activity", fn: "make" }] }] }),
      new Map([["make", ok]]),
    );
    const steps = events.filter((e): e is Extract<RunEvent, { type: "step-start" | "step-settle" }> => e.type === "step-start" || e.type === "step-settle");
    // Two steps of one phase share a name; the index keeps them apart.
    expect(steps.map((e) => [e.type, stepKey(e)])).toEqual([
      ["step-start", JSON.stringify([null, "Build", "make", 0])],
      ["step-settle", JSON.stringify([null, "Build", "make", 0])],
      ["step-start", JSON.stringify([null, "Build", "make", 1])],
      ["step-settle", JSON.stringify([null, "Build", "make", 1])],
    ]);
    expect(steps[0]!.seq).toBeLessThan(steps[1]!.seq);
  });

  test("a parallel phase starts each step before any settles, and tells two steps of one name apart by index", async () => {
    const { events } = await run(
      op({ phases: [{ name: "Fan", parallel: true, steps: [{ kind: "activity", fn: "probe", args: { at: 1 } }, { kind: "activity", fn: "probe", args: { at: 2 } }] }] }),
      new Map([["probe", ok]]),
    );
    expect(stepTrail(events)).toEqual([
      ["step-start", "probe"], ["step-start", "probe"], ["step-settle", "probe", "ok"], ["step-settle", "probe", "ok"],
    ]);
    expect(events.filter((e) => e.type === "step-settle").map((e) => (e as { index?: number }).index)).toEqual([0, 1]);
  });

  test("an unapproved gate settles gated after gate-waiting; the steps after it settle skipped as not-run", async () => {
    const { status, events } = await run(
      op({ phases: [{ name: "Ship", steps: [{ kind: "activity", fn: "before" }, { kind: "gate", gate: "approve-prod" }, { kind: "activity", fn: "after" }] }] }),
      new Map([["before", ok], ["after", ok]]),
    );
    expect(status).toBe("gated");
    expect(stepTrail(events)).toEqual([
      ["step-start", "before"], ["step-settle", "before", "ok"],
      ["step-start", "gate:approve-prod"], ["gate-waiting", "gate:approve-prod"], ["step-settle", "gate:approve-prod", "gated"],
      ["step-settle", "after", "skipped:not-run"],
    ]);
    expect(events.find((e) => e.type === "gate-waiting")).toMatchObject({ op: "deploy-api", gate: "approve-prod", point: null, index: 1 });
    expect(events.find((e) => e.type === "phase-settle")).toMatchObject({ status: "gated" });
    expect(events.at(-1)).toMatchObject({ type: "run-settle", status: "gated" });
  });

  test("an approved gate resolves, naming who approved it", async () => {
    const gates = memoryGateLedgerPort({
      resolutions: [{ version: 1, op: "deploy-api", gate: "approve-prod", resolvedBy: "alex", timestamp: "2026-10-16T11:00:00.000Z" }],
    });
    const { status, events } = await run(op({ phases: [{ name: "Ship", steps: [{ kind: "gate", gate: "approve-prod" }] }] }), new Map(), { gates });
    expect(status).toBe("ok");
    expect(events.find((e) => e.type === "gate-resolved")).toMatchObject({ gate: "approve-prod", resolvedBy: "alex", via: null, index: 0 });
  });

  test("a failed step fails its phase and the run, with its error, and the rest of its phase is not-run", async () => {
    const boom: ActivityFn = async () => { throw new Error("disk full"); };
    const { status, events } = await run(
      op({ phases: [{ name: "Build", steps: [{ kind: "activity", fn: "make" }, { kind: "activity", fn: "pack" }] }] }),
      new Map([["make", boom], ["pack", ok]]),
    );
    expect(status).toBe("fail");
    expect(stepTrail(events)).toEqual([["step-start", "make"], ["step-settle", "make", "failed"], ["step-settle", "pack", "skipped:not-run"]]);
    expect(events.find((e) => e.type === "phase-settle")).toMatchObject({ status: "failed" });
    expect(events.at(-1)).toMatchObject({ type: "run-settle", status: "failed", error: "disk full" });
  });

  test("an effect whose receipt matched settles its steps skipped with skip: receipt", async () => {
    const seeded = EffectReceipt("seeded", { effect: "db-seed", flavor: "hash", inputs: { version: 3 } });
    const values = new Map<string, string>([["seeded", receiptExpectation(seeded)]]);
    const store: ReceiptStore = {
      read: async (r) => values.get(r.name),
      write: async (r, e) => void values.set(r.name, e),
    };
    const { receiptRead, receiptWrite } = receiptActivities(store);
    const { status, events } = await run(
      op({ phases: [{ name: "Seed", steps: [effect(seeded, [{ kind: "activity", fn: "seed" }])] }] }),
      new Map<string, ActivityFn>([["seed", ok], ["receiptRead", receiptRead as unknown as ActivityFn], ["receiptWrite", receiptWrite as unknown as ActivityFn]]),
    );
    expect(status).toBe("ok");
    expect(stepTrail(events)).toEqual([
      ["step-start", "receiptRead"], ["step-settle", "receiptRead", "ok"],
      ["step-settle", "seed", "skipped:receipt"],
    ]);
  });

  test("a run that throws before its first phase still ends its stream, failed with the reason", async () => {
    const lines: string[] = [];
    await expect(
      runOpLocally(op({ phases: [{ name: "P", parallel: true, steps: [effect(EffectReceipt("r", { effect: "e", flavor: "existence", inputs: {} }), [])] }] }), new Map(), PROFILES, undefined, {
        gates: memoryGateLedgerPort(), now: NOW, commit: SHA, runEvents: { write: (l) => lines.push(l) },
      }),
    ).rejects.toThrow(/cannot run in a parallel phase/);
    const events = checkRunEventLines(lines);
    expect(events.map((e) => e.type)).toEqual(["run-start", "run-settle"]);
    expect(events.at(-1)).toMatchObject({ status: "failed", error: expect.stringMatching(/cannot run in a parallel phase/) });
  });
});
