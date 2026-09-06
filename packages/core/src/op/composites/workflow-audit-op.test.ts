import { describe, test, expect } from "vitest";
import { WorkflowAuditOp } from "./workflow-audit-op";

function opProps(op: unknown): Record<string, unknown> {
  return (op as { props: Record<string, unknown> }).props;
}

describe("WorkflowAuditOp composite (#292)", () => {
  test("one-shot form: op only, no cadence", () => {
    const { op } = WorkflowAuditOp({ name: "actions-audit" });
    expect(op).toBeDefined();
    expect(opProps(op).schedule).toBeUndefined();
  });

  test("scheduled form: the cron rides on the op (#2120)", () => {
    const { op } = WorkflowAuditOp({
      name: "actions-audit",
      schedule: "0 6 * * *",
      onFinding: "pull-request",
    });
    expect(opProps(op).schedule).toEqual({ cron: "0 6 * * *", overlap: "skip" });
    const step = (opProps(op).phases as Array<{ steps: Array<{ args: { mode: string } }> }>)[0].steps[0];
    expect(step.args.mode).toBe("pull-request");
  });
});
