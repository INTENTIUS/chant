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

describe("ReconcileOp composite — the finding step names its Op (#2319)", () => {
  test("passes the Op's own name as `op`, which is what keeps the issue marker unique", () => {
    const { op } = ReconcileOp({ name: "prod-reconcile", env: "prod", onDrift: "issue" });
    expect((reconcileStep(op).args as { op: string }).op).toBe("prod-reconcile");
  });

  test("two Ops over one env carry two identities", () => {
    // The collision #2319 reports: `env` alone is shared here by construction,
    // and a `TerraformWatchOp` over a root named "prod" would share it too.
    const a = ReconcileOp({ name: "prod-reconcile", env: "prod", onDrift: "issue" });
    const b = ReconcileOp({ name: "prod-reconcile-owned", env: "prod", onDrift: "issue" });
    const argsA = reconcileStep(a.op).args as { op: string; env: string };
    const argsB = reconcileStep(b.op).args as { op: string; env: string };
    expect(argsA.env).toBe(argsB.env);
    expect(argsA.op).not.toBe(argsB.op);
  });
});

describe("ReconcileOp composite — cadence on the op (#2120)", () => {
  function opProps(op: unknown): Record<string, unknown> {
    return (op as { props: Record<string, unknown> }).props;
  }

  test("one-shot form carries no schedule", () => {
    const { op } = ReconcileOp({ name: "prod-reconcile", env: "prod" });
    expect(opProps(op).schedule).toBeUndefined();
  });

  test("a cron lands on the op as { cron, overlap: \"skip\" }", () => {
    const { op } = ReconcileOp({ name: "prod-reconcile", env: "prod", schedule: "0 * * * *" });
    expect(opProps(op).schedule).toEqual({ cron: "0 * * * *", overlap: "skip" });
  });
});
