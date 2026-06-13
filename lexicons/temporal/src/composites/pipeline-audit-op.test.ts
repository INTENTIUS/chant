import { describe, test, expect } from "vitest";
import { PipelineAuditOp } from "./pipeline-audit-op";

describe("PipelineAuditOp composite (#303)", () => {
  test("one-shot form: op only, no schedule", () => {
    const { op, schedule } = PipelineAuditOp({ name: "pipeline-audit" });
    expect(op).toBeDefined();
    expect(schedule).toBeUndefined();
  });

  test("scheduled form: op + TemporalSchedule with merge-request finding mode", () => {
    const { op, schedule } = PipelineAuditOp({
      name: "pipeline-audit",
      schedule: "0 6 * * *",
      onFinding: "merge-request",
    });
    expect(op).toBeDefined();
    expect(schedule).toBeDefined();
    const props = (schedule as unknown as { props: Record<string, unknown> }).props;
    expect(props.scheduleId).toBe("pipeline-audit-schedule");
    expect((props.action as { workflowType: string }).workflowType).toBe("pipelineAuditWorkflow");
  });
});
