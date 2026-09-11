import { describe, expect, test } from "vitest";
import { BehaviourOp } from "./behaviour-op";

/** Reach into the generated Op's phases → the behaviourFinding step. */
function findingStep(op: unknown): Record<string, unknown> {
  const config = (op as { props: Record<string, unknown> }).props;
  const phases = config.phases as Array<{ name: string; steps: Array<Record<string, unknown>> }>;
  const predict = phases.find((p) => p.name === "Predict");
  if (!predict) throw new Error("no Predict phase");
  return predict.steps[0];
}

describe("BehaviourOp composite (#2358)", () => {
  test("one phase, one step, calling behaviourFinding in comment mode with the Op's own name as `op`", () => {
    const { op } = BehaviourOp({ name: "pr-behaviour", env: "prod", traffic: "1000 rps, p99" });
    const step = findingStep(op);
    expect(step.fn).toBe("behaviourFinding");
    expect(step.args).toEqual({ environment: "prod", traffic: "1000 rps, p99", op: "pr-behaviour", mode: "comment" });
    expect(step.outcomeAttribute).toEqual([
      { name: "Refused", from: "refused" },
      { name: "Comment", from: "commentUrl" },
    ]);
  });

  test("report mode carries no comment outcome, and an explicit base reaches the step", () => {
    const { op } = BehaviourOp({ name: "pr-behaviour", env: "prod", traffic: "1000 rps, p99", findingMode: "report", base: "main" });
    const step = findingStep(op);
    expect((step.args as { mode: string; base: string }).mode).toBe("report");
    expect((step.args as { base: string }).base).toBe("main");
    expect(step.outcomeAttribute).toEqual([{ name: "Refused", from: "refused" }]);
  });

  test("scope, stack and region flow into the step; no schedule ever lands on the Op", () => {
    const { op } = BehaviourOp({
      name: "pr-behaviour",
      env: "prod",
      traffic: "100 rps, p50",
      stack: "checkout",
      region: "us-east-1",
      scope: { owned: true },
    });
    const args = findingStep(op).args as Record<string, unknown>;
    expect(args.stack).toBe("checkout");
    expect(args.region).toBe("us-east-1");
    expect(args.owned).toBe(true);
    const props = (op as unknown as { props: Record<string, unknown> }).props;
    expect(props.schedule).toBeUndefined();
    expect(props.labels).toEqual({ Behaviour: "true", Env: "prod" });
  });

  test("two Ops over one env carry two identities", () => {
    const a = BehaviourOp({ name: "pr-behaviour", env: "prod", traffic: "100 rps, p50" });
    const b = BehaviourOp({ name: "pr-behaviour-peak", env: "prod", traffic: "1000 rps, p99" });
    expect((findingStep(a.op).args as { op: string }).op).not.toBe((findingStep(b.op).args as { op: string }).op);
  });
});
