import { describe, test, expect } from "vitest";
import { extractStepRecords, countActivities, queryGateState } from "./op-progress";
import type { OpConfig } from "../../op/types";
import type { EffectReceiptRef } from "../../op/receipt-store";
import type { WorkflowHistoryRaw, HistoryEvent } from "./run-client";

// Minimal history-event builders. Field shapes match what `fetchNormalizedHistory`
// produces: short PascalCase `eventType`, decimal-string `eventId`/`scheduledEventId`.
function scheduled(eventId: string, fn: string, at: Date): HistoryEvent {
  return {
    eventId,
    eventType: "ActivityTaskScheduled",
    eventTime: at,
    activityTaskScheduledEventAttributes: { activityId: eventId, activityType: { name: fn } },
  };
}
function completed(scheduledEventId: string, at: Date): HistoryEvent {
  return {
    eventType: "ActivityTaskCompleted",
    eventTime: at,
    activityTaskCompletedEventAttributes: { scheduledEventId },
  };
}
function failed(scheduledEventId: string, at: Date, message = "boom"): HistoryEvent {
  return {
    eventType: "ActivityTaskFailed",
    eventTime: at,
    activityTaskFailedEventAttributes: { scheduledEventId, failure: { message } },
  };
}

const T0 = new Date("2026-05-01T00:00:00Z");
const sec = (n: number) => new Date(T0.getTime() + n * 1000);

describe("extractStepRecords", () => {
  test("joins two phases' activities to their declared phase, in order", () => {
    const config: OpConfig = {
      name: "op", overview: "o",
      phases: [
        { name: "Build", steps: [{ kind: "activity", fn: "build" }] },
        { name: "Deploy", steps: [{ kind: "activity", fn: "deploy" }] },
      ],
    };
    const history: WorkflowHistoryRaw = {
      events: [
        scheduled("1", "build", sec(0)),
        completed("1", sec(1)),
        scheduled("2", "deploy", sec(2)),
        completed("2", sec(4)),
      ],
    };
    const records = extractStepRecords(config, history);
    expect(records).toEqual([
      { phase: "Build", fn: "build", status: "ok", durationMs: 1000 },
      { phase: "Deploy", fn: "deploy", status: "ok", durationMs: 2000 },
    ]);
  });

  test("two steps calling the same activity each get their own scheduled event (no last-wins collision)", () => {
    const config: OpConfig = {
      name: "op", overview: "o",
      phases: [{ name: "P1", steps: [{ kind: "activity", fn: "dup" }, { kind: "activity", fn: "dup" }] }],
    };
    const history: WorkflowHistoryRaw = {
      events: [
        scheduled("1", "dup", sec(0)),
        completed("1", sec(1)), // first "dup": 1000ms, ok
        scheduled("2", "dup", sec(1)),
        failed("2", sec(1.5), "second dup failed"), // second "dup": fails
      ],
    };
    const records = extractStepRecords(config, history);
    expect(records).toEqual([
      { phase: "P1", fn: "dup", status: "ok", durationMs: 1000 },
      { phase: "P1", fn: "dup", status: "fail", durationMs: 500, error: "second dup failed" },
    ]);
  });

  test("a step not yet scheduled produces no record unless final", () => {
    const config: OpConfig = {
      name: "op", overview: "o",
      phases: [
        { name: "P1", steps: [{ kind: "activity", fn: "a" }] },
        { name: "P2", steps: [{ kind: "activity", fn: "b" }] },
      ],
    };
    const history: WorkflowHistoryRaw = { events: [scheduled("1", "a", sec(0)), completed("1", sec(1))] };

    expect(extractStepRecords(config, history)).toEqual([
      { phase: "P1", fn: "a", status: "ok", durationMs: 1000 },
    ]);
    expect(extractStepRecords(config, history, { final: true })).toEqual([
      { phase: "P1", fn: "a", status: "ok", durationMs: 1000 },
      { phase: "P2", fn: "b", status: "skipped", durationMs: 0 },
    ]);
  });

  test("a scheduled-but-not-yet-settled step produces no record", () => {
    const config: OpConfig = {
      name: "op", overview: "o",
      phases: [{ name: "P1", steps: [{ kind: "activity", fn: "a" }] }],
    };
    const history: WorkflowHistoryRaw = { events: [scheduled("1", "a", sec(0))] };
    expect(extractStepRecords(config, history)).toEqual([]);
  });

  test("a retried activity resolves to its last outcome (Failed attempt then eventual Completed)", () => {
    const config: OpConfig = {
      name: "op", overview: "o",
      phases: [{ name: "P1", steps: [{ kind: "activity", fn: "flaky" }] }],
    };
    const history: WorkflowHistoryRaw = {
      events: [
        scheduled("1", "flaky", sec(0)),
        failed("1", sec(1), "attempt 1 failed"),
        completed("1", sec(3)), // eventual success
      ],
    };
    expect(extractStepRecords(config, history)).toEqual([
      { phase: "P1", fn: "flaky", status: "ok", durationMs: 3000 },
    ]);
  });

  test("effect step: matched receipt — only receiptRead settles; nested + receiptWrite are skipped only when final", () => {
    const receipt: EffectReceiptRef = { name: "r", effect: "e", flavor: "existence", inputs: {} };
    const config: OpConfig = {
      name: "op", overview: "o",
      phases: [{
        name: "Effect",
        steps: [{ kind: "effect", receipt, steps: [{ kind: "activity", fn: "applyIt" }] }],
      }],
    };
    const history: WorkflowHistoryRaw = {
      events: [scheduled("1", "receiptRead", sec(0)), completed("1", sec(1))],
    };
    expect(extractStepRecords(config, history)).toEqual([
      { phase: "Effect", fn: "receiptRead", status: "ok", durationMs: 1000 },
    ]);
    expect(extractStepRecords(config, history, { final: true })).toEqual([
      { phase: "Effect", fn: "receiptRead", status: "ok", durationMs: 1000 },
      { phase: "Effect", fn: "applyIt", status: "skipped", durationMs: 0 },
      { phase: "Effect", fn: "receiptWrite", status: "skipped", durationMs: 0 },
    ]);
  });

  test("onFailure phases are matched in reverse declared order, matching how the workflow actually runs them", () => {
    const config: OpConfig = {
      name: "op", overview: "o",
      phases: [{ name: "Main", steps: [{ kind: "activity", fn: "boom" }] }],
      onFailure: [
        { name: "C1", steps: [{ kind: "activity", fn: "comp1" }] },
        { name: "C2", steps: [{ kind: "activity", fn: "comp2" }] },
      ],
    };
    const history: WorkflowHistoryRaw = {
      events: [
        scheduled("1", "boom", sec(0)),
        failed("1", sec(1), "boom"),
        // Compensation runs C2 then C1 (reverse of declared order).
        scheduled("2", "comp2", sec(2)),
        completed("2", sec(3)),
        scheduled("3", "comp1", sec(3)),
        completed("3", sec(4)),
      ],
    };
    expect(extractStepRecords(config, history)).toEqual([
      { phase: "Main", fn: "boom", status: "fail", durationMs: 1000, error: "boom" },
      { phase: "C2", fn: "comp2", status: "ok", durationMs: 1000 },
      { phase: "C1", fn: "comp1", status: "ok", durationMs: 1000 },
    ]);
  });
});

describe("countActivities", () => {
  test("counts scheduled and completed events", () => {
    const history: WorkflowHistoryRaw = {
      events: [scheduled("1", "a", sec(0)), scheduled("2", "b", sec(0)), completed("1", sec(1))],
    };
    expect(countActivities(history)).toEqual({ completed: 1, scheduled: 2 });
  });

  test("empty history", () => {
    expect(countActivities({})).toEqual({ completed: 0, scheduled: 0 });
  });
});

describe("queryGateState", () => {
  test("returns the query result when the handle supports it", async () => {
    const handle = { query: async () => ({ signalName: "g", since: "t" }) } as unknown as Parameters<typeof queryGateState>[0];
    expect(await queryGateState(handle)).toEqual({ signalName: "g", since: "t" });
  });

  test("returns null when the workflow reports no pending gate", async () => {
    const handle = { query: async () => null } as unknown as Parameters<typeof queryGateState>[0];
    expect(await queryGateState(handle)).toBeNull();
  });

  test("returns undefined (not an error) when the query isn't registered — e.g. an Op with no gates", async () => {
    const handle = { query: async () => { throw new Error("unregistered query"); } } as unknown as Parameters<typeof queryGateState>[0];
    expect(await queryGateState(handle)).toBeUndefined();
  });
});
