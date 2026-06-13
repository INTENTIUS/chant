import { describe, test, expect } from "vitest";
import { WorkflowAuditOp } from "./workflow-audit-op";

describe("WorkflowAuditOp composite (#292)", () => {
  test("one-shot form: op only, no schedule", () => {
    const { op, schedule } = WorkflowAuditOp({ name: "actions-audit" });
    expect(op).toBeDefined();
    expect(schedule).toBeUndefined();
  });

  test("scheduled form: op + TemporalSchedule on the given cron", () => {
    const { op, schedule } = WorkflowAuditOp({
      name: "actions-audit",
      schedule: "0 6 * * *",
      onFinding: "pull-request",
    });
    expect(op).toBeDefined();
    expect(schedule).toBeDefined();
    const props = (schedule as unknown as { props: Record<string, unknown> }).props;
    expect(props.scheduleId).toBe("actions-audit-schedule");
    expect((props.spec as { cronExpressions: string[] }).cronExpressions).toEqual(["0 6 * * *"]);
    expect((props.action as { workflowType: string }).workflowType).toBe("actionsAuditWorkflow");
  });
});
