import { describe, expect, test } from "vitest";
import { RestoreDrillOp } from "./restore-drill-op";
import { loadActivities } from "../activity-registry";
import { classifyOpVerbClass } from "../op-verb-class";
import { outcomeAttributesOf } from "../types";

function props(op: unknown): Record<string, any> {
  return (op as { props: Record<string, any> }).props;
}

const store = { kind: "rds", name: "orders", instance: "orders-prod" } as const;

describe("RestoreDrillOp (#5450)", () => {
  test("one activity step carries the store, the checks and the targets, and publishes the numbers as outcomes", () => {
    const { op } = RestoreDrillOp({
      name: "orders-restore-drill",
      env: "prod",
      store,
      checks: [{ name: "rows", kind: "command", cmd: "count", expect: { atLeast: 1 } }],
      targets: { rto: "4h", rpo: "15m" },
    });
    const p = props(op);
    expect(p.labels).toEqual({ Drill: "restore", Store: "orders", Env: "prod" });
    expect(p.schedule).toBeUndefined();
    const step = p.phases[0].steps[0];
    expect(step).toMatchObject({ kind: "activity", fn: "restoreDrill", profile: "atMostOnce", timeout: "6h" });
    expect(step.args).toMatchObject({ store, env: "prod", op: "orders-restore-drill", targets: { rto: "4h", rpo: "15m" } });
    expect(outcomeAttributesOf(step).map((o) => o.name)).toEqual(["Outcome", "RtoMs", "RpoMs", "Met", "DrillId"]);
  });

  test("a schedule rides on the op as its cadence", () => {
    const { op } = RestoreDrillOp({ name: "d", env: "prod", store, schedule: "0 3 * * 0" });
    expect(props(op).schedule).toEqual({ cron: "0 3 * * 0", overlap: "skip" });
  });

  test("a drill that could not run is refused when the Op is built", () => {
    expect(() => RestoreDrillOp({ name: "d", env: "prod", store, targets: { rto: "soon" } })).toThrow(/rto: "soon" is not a duration/);
    expect(() => RestoreDrillOp({ name: "d", env: "prod", store, scratch: "orders-prod" })).toThrow(/must start with "drill-"/);
    expect(() => RestoreDrillOp({ name: "d", env: "prod", store: { kind: "rds", name: "x y", instance: "i" } })).toThrow(/store.name/);
  });

  test("the activity resolves from the base library, and only the activity is exported as one", async () => {
    const activities = await loadActivities([]);
    expect(typeof activities.get("restoreDrill")).toBe("function");
    expect(activities.has("drillProblems")).toBe(false);
  });

  test("a drill creates and removes infrastructure, so it is not classed read-only", () => {
    const { op } = RestoreDrillOp({ name: "d", env: "prod", store });
    expect(classifyOpVerbClass(props(op) as never)).not.toBe("read-only");
  });
});
