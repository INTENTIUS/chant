import { describe, test, expect } from "vitest";
import { runOpLocally } from "@intentius/chant/op";
import type { ActivityFn, ActivityProfile } from "@intentius/chant/op";
import type { OpConfig } from "@intentius/chant/op";
import { eq, gt, run, report, when } from "@intentius/chant/op";
import type { ConvergeSymptom } from "@intentius/chant/lifecycle/symptoms";
import { ConvergeOp } from "./converge-op";

function props(op: unknown): OpConfig {
  return (op as { props: OpConfig }).props;
}

function phaseNamed(op: unknown, name: string) {
  const phase = props(op).phases.find((p) => p.name === name);
  if (!phase) throw new Error(`no "${name}" phase`);
  return phase;
}

const driftRule = when<ConvergeSymptom>(eq("status", "drifted"), run("fountain-apply"), {
  id: "drift-apply",
  why: "Re-apply converges drift back to declared source.",
});

describe("ConvergeOp composite (#1484)", () => {
  test("builds an Observe -> Converge phase pair", () => {
    const { op } = ConvergeOp({ name: "staging-converge", env: "staging", rules: [driftRule] });
    const config = props(op);
    expect(config.phases.map((p) => p.name)).toEqual(["Observe", "Converge"]);
  });

  test("Observe phase snapshots then diffs, with a Drift outcome attribute", () => {
    const { op } = ConvergeOp({ name: "staging-converge", env: "staging", rules: [driftRule] });
    const observe = phaseNamed(op, "Observe");
    expect(observe.steps).toHaveLength(2);
    expect((observe.steps[0] as { fn: string }).fn).toBe("lifecycleSnapshot");
    const diff = observe.steps[1] as { fn: string; args: Record<string, unknown>; outcomeAttribute: unknown };
    expect(diff.fn).toBe("lifecycleDiff");
    expect(diff.args.env).toBe("staging");
    expect(diff.outcomeAttribute).toEqual({ name: "Drift", from: "drifted" });
  });

  test("Converge phase calls convergeTick with the rule table, dial, and budget, threading the Observe diff via a step-output reference", () => {
    const { op } = ConvergeOp({ name: "staging-converge", env: "staging", dial: "apply", budget: 5, rules: [driftRule] });
    const converge = phaseNamed(op, "Converge");
    expect(converge.steps).toHaveLength(1);
    const tick = converge.steps[0] as { fn: string; args: Record<string, unknown>; profile: string; outcomeAttribute: unknown };
    expect(tick.fn).toBe("convergeTick");
    expect(tick.profile).toBe("longInfra");
    expect(tick.args.opName).toBe("staging-converge");
    expect(tick.args.env).toBe("staging");
    expect(tick.args.dial).toBe("apply");
    expect(tick.args.budget).toBe(5);
    expect(tick.args.rules).toEqual([driftRule]);
    expect(tick.args.preflightDrift).toMatchObject({ kind: "step-output-ref", step: "diff", path: "drifted" });
    expect(tick.outcomeAttribute).toEqual({ name: "Remediated", from: "remediated" });
  });

  test("defaults: dial observe, budget 3, live true", () => {
    const { op } = ConvergeOp({ name: "staging-converge", env: "staging", rules: [driftRule] });
    const config = props(op);
    expect(config.searchAttributes).toEqual({ Converge: "true", Env: "staging", Dial: "observe" });
    const tick = phaseNamed(op, "Converge").steps[0] as { args: Record<string, unknown> };
    expect(tick.args.dial).toBe("observe");
    expect(tick.args.budget).toBe(3);
    const diff = phaseNamed(op, "Observe").steps[1] as { args: Record<string, unknown> };
    expect(diff.args.live).toBe(true);
  });

  test("no schedule -> { op } only; a schedule -> { op, schedule }", () => {
    const noSchedule = ConvergeOp({ name: "staging-converge", env: "staging", rules: [driftRule] });
    expect(noSchedule.schedule).toBeUndefined();

    const scheduled = ConvergeOp({ name: "staging-converge", env: "staging", rules: [driftRule], schedule: "*/10 * * * *" });
    expect(scheduled.schedule).toBeDefined();
  });

  // Finding D (#1954 pre-merge review): issue #1484's acceptance criterion is
  // "skip-and-report when a prior remediation is in flight ... never queue".
  // `"Skip"` is the schedule-level overlap policy that drops a fire whose
  // predecessor is still running, rather than buffering/queuing it.
  test("a scheduled ConvergeOp sets an explicit \"Skip\" overlap policy — never queue an in-flight tick", () => {
    const { schedule } = ConvergeOp({ name: "staging-converge", env: "staging", rules: [driftRule], schedule: "*/10 * * * *" });
    const scheduleProps = (schedule as unknown as { props: { policies?: { overlap?: string } } }).props;
    expect(scheduleProps.policies?.overlap).toBe("Skip");
  });
});

describe("ConvergeOp composite — build-time refusals (#1484)", () => {
  test("refuses an empty rule table", () => {
    expect(() => ConvergeOp({ name: "x", env: "staging", rules: [] })).toThrow(/at least one rule/);
  });

  test("refuses duplicate rule ids", () => {
    const dup = when<ConvergeSymptom>(eq("status", "reconciled"), report("noop"), { id: "drift-apply", why: "y" });
    expect(() => ConvergeOp({ name: "x", env: "staging", rules: [driftRule, dup] })).toThrow(/duplicate rule id/);
  });

  test("refuses a negative or non-integer budget", () => {
    expect(() => ConvergeOp({ name: "x", env: "staging", rules: [driftRule], budget: -1 })).toThrow(/budget must be/);
    expect(() => ConvergeOp({ name: "x", env: "staging", rules: [driftRule], budget: 1.5 })).toThrow(/budget must be/);
  });

  test("refuses a rule assembled by hand with a blank why", () => {
    const noWhy = { id: "r1", when: { kind: "field-comparison", field: "status", op: "eq", value: "drifted" }, then: { kind: "report", reason: "x" }, why: "" } as unknown as typeof driftRule;
    expect(() => ConvergeOp({ name: "x", env: "staging", rules: [noWhy] })).toThrow(/carry its why/);
  });

  test("refuses a rule assembled by hand outside the evaluable subset", () => {
    const bad = { id: "r1", when: { kind: "javascript-closure" }, then: { kind: "report", reason: "x" }, why: "y" } as unknown as typeof driftRule;
    expect(() => ConvergeOp({ name: "x", env: "staging", rules: [bad] })).toThrow(/evaluable subset/);
  });
});

describe("ConvergeOp — end-to-end local run (#1484)", () => {
  const PROFILES: Record<string, ActivityProfile> = {
    fastIdempotent: { startToCloseTimeout: "5m", retry: { maximumAttempts: 1 } },
    longInfra: { startToCloseTimeout: "20m", retry: { maximumAttempts: 1 } },
  };

  test("chant run <converge-op>: observes, then ticks, resolving the step-output reference into the tick's args", async () => {
    const { op } = ConvergeOp({ name: "staging-converge", env: "staging", dial: "apply", budget: 2, rules: [driftRule] });
    const config = props(op);

    let receivedArgs: Record<string, unknown> | undefined;
    const activities = new Map<string, ActivityFn>([
      ["lifecycleSnapshot", (async () => undefined) as ActivityFn],
      ["lifecycleDiff", (async () => ({ output: "DRIFTED (1)", exitCode: 0, drifted: true })) as ActivityFn],
      [
        "convergeTick",
        (async (args) => {
          receivedArgs = args;
          return { drifted: true, remediated: 1, reported: 0, skippedBudget: 0, skippedFlap: 0, unobserved: 0, adopted: 0, log: "converge(staging): remediated=1" };
        }) as ActivityFn,
      ],
    ]);

    const result = await runOpLocally(config, activities, PROFILES);

    expect(result.ok).toBe(true);
    // The step-output reference resolved to the real value the Observe phase produced.
    expect(receivedArgs?.preflightDrift).toBe(true);
    expect(receivedArgs?.dial).toBe("apply");
    expect(receivedArgs?.budget).toBe(2);
    expect(receivedArgs?.opName).toBe("staging-converge");
  });

  test("a ConvergeOp with a gated dispatch target still runs locally itself — the tick's own phases carry no gate", async () => {
    // ConvergeOp's own generated workflow never contains a gate step (dispatch
    // to a gated Op happens inside convergeTick's own subprocess dispatch, not
    // as a step in this Op's phases) — so the local runner never refuses it.
    const { op } = ConvergeOp({ name: "staging-converge", env: "staging", dial: "apply", rules: [driftRule] });
    const config = props(op);
    expect(config.phases.every((p) => p.steps.every((s) => s.kind !== "gate"))).toBe(true);

    const activities = new Map<string, ActivityFn>([
      ["lifecycleSnapshot", (async () => undefined) as ActivityFn],
      ["lifecycleDiff", (async () => ({ output: "", exitCode: 0, drifted: false })) as ActivityFn],
      ["convergeTick", (async () => ({ drifted: false, remediated: 0, reported: 0, skippedBudget: 0, skippedFlap: 0, unobserved: 0, adopted: 0, log: "" })) as ActivityFn],
    ]);
    const result = await runOpLocally(config, activities, PROFILES);
    expect(result.ok).toBe(true);
  });
});
