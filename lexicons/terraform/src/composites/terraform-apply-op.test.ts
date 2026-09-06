/**
 * TerraformApplyOp composite tests (#2086) — the phase names, the gate, the
 * plan-to-apply reference, and the compensation refusal.
 */

import { describe, test, expect } from "vitest";
import {
  findGate,
  isStepOutputRef,
  runOpLocally,
  LocalGateUnsupportedError,
  type ActivityStep,
  type GateStep,
  type OpConfig,
  type StepDefinition,
} from "@intentius/chant/op";
import { TerraformApplyOp } from "./terraform-apply-op";

/** The Op's declared config, which is what `chant build` serializes. */
function props(config: Parameters<typeof TerraformApplyOp>[0]): OpConfig {
  return (TerraformApplyOp(config).op as unknown as { props: OpConfig }).props;
}

const phaseNames = (op: OpConfig): string[] => op.phases.map((p) => p.name);
const isActivity = (s: StepDefinition): s is ActivityStep => s.kind === "activity";
const isGate = (s: StepDefinition): s is GateStep => s.kind === "gate";

describe("TerraformApplyOp phases (#2086)", () => {
  test("default gate mode is on-destroy: Init, Plan, Gate, Apply", () => {
    expect(phaseNames(props({ name: "app-apply", root: "app" }))).toEqual([
      "Init",
      "Plan",
      "Gate",
      "Apply",
    ]);
  });

  test('gate: "always" builds the same four phases', () => {
    expect(phaseNames(props({ name: "app-apply", root: "app", gate: "always" }))).toEqual([
      "Init",
      "Plan",
      "Gate",
      "Apply",
    ]);
  });

  test('gate: "never" emits no Gate phase, which is what makes the Op runnable locally', () => {
    const op = props({ name: "app-apply", root: "app", gate: "never" });
    expect(phaseNames(op)).toEqual(["Init", "Plan", "Apply"]);
    expect(op.phases.flatMap((p) => p.steps).some(isGate)).toBe(false);
  });

  test("each phase runs the activity it is named for, with the root threaded through", () => {
    const op = props({ name: "app-apply", root: "app", gate: "never" });
    const fns = op.phases.flatMap((p) => p.steps.filter(isActivity)).map((s) => s.fn);
    expect(fns).toEqual(["terraformInit", "terraformPlan", "terraformApply"]);
    for (const step of op.phases.flatMap((p) => p.steps.filter(isActivity))) {
      expect(step.args?.root).toBe("app");
    }
  });

  test("Init and Apply carry longInfra; the gate's show step is fastIdempotent", () => {
    const op = props({ name: "app-apply", root: "app" });
    const byPhase = Object.fromEntries(op.phases.map((p) => [p.name, p.steps.filter(isActivity)]));
    expect(byPhase.Init[0].profile).toBe("longInfra");
    expect(byPhase.Plan[0].profile).toBe("longInfra");
    expect(byPhase.Gate[0].profile).toBe("fastIdempotent");
    expect(byPhase.Apply[0].profile).toBe("longInfra");
  });
});

describe("TerraformApplyOp gate (#2086)", () => {
  test("signal name defaults to approve-<name>", () => {
    const op = props({ name: "prod-apply", root: "app" });
    const gate = op.phases.find((p) => p.name === "Gate")!.steps.find(isGate)!;
    expect(gate.signalName).toBe("approve-prod-apply");
  });

  test("an explicit signalName, timeout and description win", () => {
    const op = props({
      name: "prod-apply",
      root: "app",
      signalName: "approve-terraform",
      gateTimeout: "72h",
      gateDescription: "Change window only",
    });
    const gate = op.phases.find((p) => p.name === "Gate")!.steps.find(isGate)!;
    expect(gate).toMatchObject({
      signalName: "approve-terraform",
      timeout: "72h",
      description: "Change window only",
    });
  });

  test("the Gate phase reports the plan's destroy count before it waits", () => {
    // GateStep has no condition field, so "on-destroy" cannot branch at build
    // time. The approver is told instead: a `show` of the saved plan runs
    // first and surfaces `destroys` as a search attribute.
    const op = props({ name: "prod-apply", root: "app" });
    const steps = op.phases.find((p) => p.name === "Gate")!.steps;
    const show = steps[0] as ActivityStep;
    expect(show.fn).toBe("terraformShow");
    expect(show.outcomeAttribute).toEqual({ name: "Destroys", from: "destroys" });
    expect(steps[1].kind).toBe("gate");
    expect(isStepOutputRef(show.args?.planFile)).toBe(true);
  });
});

describe("TerraformApplyOp plan-to-apply reference (#2086)", () => {
  test("Plan surfaces `changed`, and Apply applies that step's own plan file", () => {
    const op = props({ name: "app-apply", root: "app", gate: "never" });
    const plan = op.phases.find((p) => p.name === "Plan")!.steps[0] as ActivityStep;
    const apply = op.phases.find((p) => p.name === "Apply")!.steps[0] as ActivityStep;

    expect(plan.id).toBe("plan");
    expect(plan.outcomeAttribute).toEqual({ name: "Changed", from: "changed" });
    expect(plan.args?.planFile).toBe("chant.tfplan");

    const ref = apply.args?.planFile;
    expect(isStepOutputRef(ref)).toBe(true);
    expect(ref).toMatchObject({ step: "plan", path: "planFile" });
  });

  test("an explicit planFile is what Plan writes and Apply reads back by reference", () => {
    const op = props({ name: "app-apply", root: "app", gate: "never", planFile: "prod.tfplan" });
    const plan = op.phases.find((p) => p.name === "Plan")!.steps[0] as ActivityStep;
    expect(plan.args?.planFile).toBe("prod.tfplan");
  });

  test("upgrade is opt-in on the Init step", () => {
    const withUpgrade = props({ name: "a", root: "app", gate: "never", upgrade: true });
    const without = props({ name: "a", root: "app", gate: "never" });
    expect((withUpgrade.phases[0].steps[0] as ActivityStep).args).toEqual({ root: "app", upgrade: true });
    expect((without.phases[0].steps[0] as ActivityStep).args).toEqual({ root: "app" });
  });
});

describe("TerraformApplyOp compensation — total or refused (#2086)", () => {
  test("compensate: true throws at build time, naming the Op and terraform's lack of rollback", () => {
    expect(() => TerraformApplyOp({ name: "prod-apply", root: "app", compensate: true })).toThrow(
      /TerraformApplyOp "prod-apply".*no automatic rollback/s,
    );
  });

  test("an object without a command is refused the same way", () => {
    expect(() => TerraformApplyOp({ name: "prod-apply", root: "app", compensate: {} })).toThrow(
      /TerraformApplyOp "prod-apply"/,
    );
  });

  test("compensate: false and the default build no onFailure phase", () => {
    expect(props({ name: "a", root: "app", compensate: false }).onFailure).toBeUndefined();
    expect(props({ name: "a", root: "app" }).onFailure).toBeUndefined();
  });

  test("compensate: { command } builds an onFailure Rollback phase running that command", () => {
    const op = props({
      name: "a",
      root: "app",
      compensate: { command: "terraform apply -input=false rollback.tfplan" },
    });
    expect(op.onFailure?.map((p) => p.name)).toEqual(["Rollback"]);
    expect(op.onFailure![0].steps[0]).toMatchObject({
      kind: "activity",
      fn: "shellCmd",
      args: { cmd: "terraform apply -input=false rollback.tfplan" },
    });
  });
});

describe("TerraformApplyOp on the local executor (#2086)", () => {
  test("a gated Op is refused up front, naming the signal the local executor cannot wait for", async () => {
    const op = props({ name: "prod-apply", root: "app" });
    await expect(runOpLocally(op, new Map(), {})).rejects.toBeInstanceOf(LocalGateUnsupportedError);
  });

  test('gate: "never" clears that refusal, which is what makes `chant run` viable', () => {
    expect(findGate(props({ name: "prod-apply", root: "app", gate: "never" }))).toBeUndefined();
  });
});

describe("TerraformApplyOp Op metadata (#2086)", () => {
  test("task queue defaults to the name and search attributes name the root", () => {
    const op = props({ name: "app-apply", root: "app" });
    expect(op.name).toBe("app-apply");
    expect(op.taskQueue).toBe("app-apply");
    expect(op.searchAttributes).toEqual({ Apply: "true", TerraformRoot: "app" });
  });

  test("an explicit taskQueue wins", () => {
    expect(props({ name: "app-apply", root: "app", taskQueue: "infra" }).taskQueue).toBe("infra");
  });
});
