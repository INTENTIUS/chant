import { describe, test, expect } from "vitest";
import { ReconcileOp } from "./reconcile-op";

/** Reach into the generated Op's phases → the reconcilePr step. */
function reconcileStep(op: unknown): Record<string, unknown> {
  const config = (op as { props: Record<string, unknown> }).props;
  const phases = config.phases as Array<{ name: string; steps: Array<Record<string, unknown>> }>;
  const reconcile = phases.find((p) => p.name === "Reconcile");
  if (!reconcile) throw new Error("no Reconcile phase");
  return reconcile.steps[0];
}

describe("ReconcileOp composite — PR/issue URL outcome (#8)", () => {
  test("pull-request mode (default) exposes prUrl as the PR outcome attribute", () => {
    const { op } = ReconcileOp({ name: "prod-reconcile", env: "prod" });
    const step = reconcileStep(op);
    expect(step.fn).toBe("reconcilePr");
    expect((step.args as { mode: string }).mode).toBe("pull-request");
    expect(step.outcomeAttribute).toEqual({ name: "PR", from: "prUrl" });
  });

  test("issue mode exposes issueUrl as the Issue outcome attribute", () => {
    const { op } = ReconcileOp({ name: "prod-reconcile", env: "prod", onDrift: "issue" });
    const step = reconcileStep(op);
    expect((step.args as { mode: string }).mode).toBe("issue");
    expect(step.outcomeAttribute).toEqual({ name: "Issue", from: "issueUrl" });
  });

  test("report mode opens nothing, so carries no URL outcome", () => {
    const { op } = ReconcileOp({ name: "prod-reconcile", env: "prod", onDrift: "report" });
    const step = reconcileStep(op);
    expect((step.args as { mode: string }).mode).toBe("report");
    expect(step.outcomeAttribute).toBeUndefined();
  });
});
