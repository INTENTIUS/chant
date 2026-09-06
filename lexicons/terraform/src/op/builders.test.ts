/**
 * Typed step-builder tests (#2086), following
 * `lexicons/k3s/src/op/builders.test.ts`: the produced `ActivityStep` shape,
 * profile defaults, `id` routing to the step rather than into `args`, and the
 * `StepOutputRef` an Apply step takes from a Plan step's `.out`.
 */

import { describe, test, expect } from "vitest";
import { isStepOutputRef, type StepOutputRef } from "@intentius/chant/op";
import {
  terraformInit,
  terraformPlan,
  terraformApply,
  terraformShow,
  choudoufuLivePlan,
  choudoufuLiveLs,
  choudoufuLiveCheck,
} from "./builders";

describe("terraform typed step builders (#2086)", () => {
  test("terraformInit: root is positional, longInfra by default", () => {
    expect(terraformInit("app")).toMatchObject({
      kind: "activity",
      fn: "terraformInit",
      args: { root: "app" },
      profile: "longInfra",
    });
  });

  test("terraformInit: opts land in args, profile can be overridden", () => {
    expect(terraformInit("app", { upgrade: true, profile: "fastIdempotent" })).toMatchObject({
      fn: "terraformInit",
      args: { root: "app", upgrade: true },
      profile: "fastIdempotent",
    });
  });

  test("terraformPlan: longInfra by default", () => {
    expect(terraformPlan("app", { planFile: "chant.tfplan" })).toMatchObject({
      fn: "terraformPlan",
      args: { root: "app", planFile: "chant.tfplan" },
      profile: "longInfra",
    });
  });

  test("terraformApply: longInfra by default", () => {
    expect(terraformApply("app", { planFile: "chant.tfplan" })).toMatchObject({
      fn: "terraformApply",
      args: { root: "app", planFile: "chant.tfplan" },
      profile: "longInfra",
    });
  });

  test("terraformShow: fastIdempotent by default, since show calls no provider", () => {
    expect(terraformShow("app")).toMatchObject({ fn: "terraformShow", profile: "fastIdempotent" });
  });

  test("id routes to the step's own id field, never into args", () => {
    const step = terraformPlan("app", { id: "plan" });
    expect(step.id).toBe("plan");
    expect(step.args).toEqual({ root: "app" });
  });

  test("an Apply step referencing plan.out.planFile serializes as a StepOutputRef", () => {
    const plan = terraformPlan("app", { planFile: "chant.tfplan", id: "plan" });
    const apply = terraformApply("app", { planFile: plan.out.planFile });

    const ref = apply.args?.planFile as StepOutputRef;
    expect(isStepOutputRef(ref)).toBe(true);
    expect(ref.step).toBe("plan");
    expect(ref.path).toBe("planFile");
    // The reference is inert data on the step, so it survives a JSON round
    // trip into the generated workflow rather than collapsing to a string.
    expect(JSON.parse(JSON.stringify(apply)).args.planFile).toEqual({
      kind: "step-output-ref",
      step: "plan",
      path: "planFile",
    });
  });

  test(".out throws when the producing step has no id", () => {
    expect(() => terraformPlan("app").out.planFile).toThrow(/has no id/);
  });

  test("terraformApply: no opts at all is valid (#2103, a live root's bare apply)", () => {
    expect(terraformApply("estate")).toMatchObject({
      fn: "terraformApply",
      args: { root: "estate" },
      profile: "longInfra",
    });
    expect(terraformApply("estate").args?.planFile).toBeUndefined();
  });
});

describe("choudoufu typed step builders (#2103)", () => {
  test("choudoufuLivePlan: root is positional, longInfra by default, estate is optional", () => {
    expect(choudoufuLivePlan("estate")).toMatchObject({
      kind: "activity",
      fn: "choudoufuLivePlan",
      args: { root: "estate" },
      profile: "longInfra",
    });
    expect(choudoufuLivePlan("estate", { estate: "prod-networking" })).toMatchObject({
      args: { root: "estate", estate: "prod-networking" },
    });
  });

  test("choudoufuLivePlan: .out refs for drift, unowned, adoptable and documentPath", () => {
    const plan = choudoufuLivePlan("estate", { id: "live-plan" });
    expect(isStepOutputRef(plan.out.drift as StepOutputRef)).toBe(true);
    expect((plan.out.unowned as StepOutputRef).path).toBe("unowned");
    expect((plan.out.adoptable as StepOutputRef).path).toBe("adoptable");
    expect((plan.out.documentPath as StepOutputRef).path).toBe("documentPath");
  });

  test("choudoufuLiveLs: fastIdempotent by default", () => {
    expect(choudoufuLiveLs("estate", { consistent: true })).toMatchObject({
      fn: "choudoufuLiveLs",
      args: { root: "estate", consistent: true },
      profile: "fastIdempotent",
    });
  });

  test("choudoufuLiveCheck: fastIdempotent by default, no opts needed at all", () => {
    expect(choudoufuLiveCheck("estate")).toMatchObject({
      kind: "activity",
      fn: "choudoufuLiveCheck",
      args: { root: "estate" },
      profile: "fastIdempotent",
    });
  });
});

// ── Compile-time-only: authoring-time type errors (never executed) ──────────
function _typeChecksOnly(): void {
  // @ts-expect-error — "planfile" (wrong case) is not a key of TerraformApplyArgs.
  terraformApply("app", { planfile: "chant.tfplan" });

  // @ts-expect-error — `root` is positional; it is not a member of opts.
  terraformInit("app", { root: "other" });

  // @ts-expect-error: "estatee" (typo) is not a key of ChoudoufuLivePlanArgs.
  choudoufuLivePlan("estate", { estatee: "prod" });
}
void _typeChecksOnly;
