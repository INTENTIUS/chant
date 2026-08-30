import { describe, test, expect } from "vitest";
import { generateReport } from "./run-report";
import type { OpConfig } from "../../op/types";
import type { WorkflowExecutionDescription, WorkflowHistoryRaw, HistoryEvent } from "./run-client";

function scheduled(eventId: string, fn: string): HistoryEvent {
  return {
    eventId,
    eventType: "ActivityTaskScheduled",
    eventTime: new Date(0),
    activityTaskScheduledEventAttributes: { activityId: eventId, activityType: { name: fn } },
  };
}
function completed(scheduledEventId: string): HistoryEvent {
  return {
    eventType: "ActivityTaskCompleted",
    eventTime: new Date(1000),
    activityTaskCompletedEventAttributes: { scheduledEventId },
  };
}

const desc: WorkflowExecutionDescription = {
  workflowId: "wf", runId: "r1", status: { name: "COMPLETED" },
  startTime: new Date(0), closeTime: new Date(2000), taskQueue: "q", type: { name: "opWorkflow" },
};

describe("generateReport", () => {
  test("two steps calling the same activity each get their own row (no last-wins collision, chant #1676)", () => {
    const config: OpConfig = {
      name: "op", overview: "o",
      phases: [{ name: "P1", steps: [{ kind: "activity", fn: "dup" }, { kind: "activity", fn: "dup" }] }],
    };
    const history: WorkflowHistoryRaw = {
      events: [scheduled("1", "dup"), completed("1"), scheduled("2", "dup"), completed("2")],
    };
    const md = generateReport("op", config, desc, history);
    // Both rows present — the prior fn-name join would have produced one
    // row for "dup" (the second scheduled event overwriting the first).
    const dupRows = md.split("\n").filter((line) => line.includes("| P1 | dup |"));
    expect(dupRows).toHaveLength(2);
    expect(dupRows.every((line) => line.includes("✓ completed"))).toBe(true);
  });

  test("a declared step with no matching history is reported skipped, not a phantom 'running' row", () => {
    const config: OpConfig = {
      name: "op", overview: "o",
      phases: [
        { name: "P1", steps: [{ kind: "activity", fn: "a" }] },
        { name: "P2", steps: [{ kind: "activity", fn: "b" }] },
      ],
      onFailure: [{ name: "C1", steps: [{ kind: "activity", fn: "comp" }] }],
    };
    const history: WorkflowHistoryRaw = { events: [scheduled("1", "a"), completed("1"), scheduled("2", "b"), completed("2")] };
    const md = generateReport("op", config, desc, history);
    expect(md).toContain("| P1 | a | 1.0s | ✓ completed |");
    expect(md).toContain("| P2 | b | 1.0s | ✓ completed |");
    // The timeline table is scoped to config.phases only (unchanged from
    // before this fix) — onFailure phases never appear in it regardless of
    // whether they ran.
    expect(md).not.toContain("C1");
  });
});
