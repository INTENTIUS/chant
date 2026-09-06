import { describe, test, expect } from "vitest";
import { PipelineAuditOp } from "./pipeline-audit-op";

function opProps(op: unknown): Record<string, unknown> {
  return (op as { props: Record<string, unknown> }).props;
}

describe("PipelineAuditOp composite (#303)", () => {
  test("one-shot form: op only, no cadence", () => {
    const { op } = PipelineAuditOp({ name: "pipeline-audit" });
    expect(op).toBeDefined();
    expect(opProps(op).schedule).toBeUndefined();
  });

  test("scheduled form: the cron rides on the op, with the merge-request finding mode (#2120)", () => {
    const { op } = PipelineAuditOp({
      name: "pipeline-audit",
      schedule: "0 6 * * *",
      onFinding: "merge-request",
    });
    expect(opProps(op).schedule).toEqual({ cron: "0 6 * * *", overlap: "skip" });
    const step = (opProps(op).phases as Array<{ steps: Array<{ args: { mode: string } }> }>)[0].steps[0];
    expect(step.args.mode).toBe("merge-request");
  });
});
