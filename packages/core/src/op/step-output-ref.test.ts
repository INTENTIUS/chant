/**
 * Step-output reference tests (chant #1290).
 *
 * Mirrors activity-contract.test.ts's shape: a small lifecycleDiff-shaped
 * contract so the test doesn't need a real lexicon.
 */

import { describe, expect, it } from "vitest";
import { z } from "zod";
import { activity, phase, effect } from "./builders";
import type { OpConfig } from "./types";
import { activityContract, type ActivityContract } from "./activity-contract";
import { stepOutput, isStepOutputRef, collectStepOutputRefs, validateStepOutputRefs } from "./step-output-ref";
import { EffectReceipt } from "../effect-receipt";

const lifecycleDiffContract = activityContract(
  "lifecycleDiff",
  z.strictObject({ env: z.string(), live: z.boolean().optional() }),
  z.object({ output: z.string(), exitCode: z.number(), drifted: z.boolean(), driftedStacks: z.array(z.string()) }),
);

const applyStacksContract = activityContract("applyStacks", z.strictObject({ stacks: z.array(z.string()) }));

// A producer with no `returns` schema — every arg is fine, nothing to
// validate a reference into its output against.
const noReturnContract = activityContract("shellCmd", z.strictObject({ cmd: z.string() }));

function opWith(config: Partial<OpConfig> & Pick<OpConfig, "phases">): Pick<OpConfig, "name" | "phases" | "onFailure"> {
  return { name: "test-op", ...config };
}

// ── stepOutput() / isStepOutputRef() ────────────────────────────────────────

describe("stepOutput()", () => {
  it("brands its result so isStepOutputRef recognizes it", () => {
    const ref = stepOutput("diff", "driftedStacks");
    expect(isStepOutputRef(ref)).toBe(true);
    expect(ref.step).toBe("diff");
    expect(ref.path).toBe("driftedStacks");
  });

  it("omitting path references the whole return value", () => {
    const ref = stepOutput("diff");
    expect(ref.path).toBeUndefined();
  });

  it("accepts a step object with an id, not just a bare string", () => {
    const diff = activity("lifecycleDiff", { env: "prod" }, { id: "diff" });
    expect(stepOutput(diff, "driftedStacks")).toEqual(stepOutput("diff", "driftedStacks"));
  });

  it("throws when the step has no id", () => {
    expect(() => stepOutput({}, "x")).toThrow(/no `id`/);
  });

  it("isStepOutputRef rejects a plain object with the same shape", () => {
    expect(isStepOutputRef({ step: "diff", path: "x" })).toBe(false);
    expect(isStepOutputRef(null)).toBe(false);
    expect(isStepOutputRef(undefined)).toBe(false);
  });

  it("throws when coerced to a primitive — references only, no expressions", () => {
    const ref = stepOutput("diff", "count");
    expect(() => `${ref}`).toThrow(/coerced to a primitive/);
    expect(() => Number(ref)).toThrow(/coerced to a primitive/);
    expect(() => String(ref)).toThrow(/coerced to a primitive/);
  });
});

// ── activity()'s `.out` proxy ───────────────────────────────────────────────

describe("activity().out", () => {
  it("diff.out.field builds a reference to this step's declared output", () => {
    const diff = activity("lifecycleDiff", { env: "prod" }, { id: "diff" });
    const ref = diff.out.driftedStacks;
    expect(isStepOutputRef(ref)).toBe(true);
    expect(ref.step).toBe("diff");
    expect(ref.path).toBe("driftedStacks");
  });

  it("diff.out itself (unaccessed) references the whole return value", () => {
    const diff = activity("lifecycleDiff", { env: "prod" }, { id: "diff" });
    expect(isStepOutputRef(diff.out)).toBe(true);
    expect(diff.out.path).toBeUndefined();
    expect(diff.out.step).toBe("diff");
  });

  it("throws when the step has no id", () => {
    const diff = activity("lifecycleDiff", { env: "prod" });
    expect(() => diff.out).toThrow(/has no id/);
  });

  it("out is non-enumerable — doesn't leak into the step's own JSON shape", () => {
    const diff = activity("lifecycleDiff", { env: "prod" }, { id: "diff" });
    expect(Object.keys(diff)).not.toContain("out");
    expect(JSON.stringify(diff)).not.toContain("out");
  });

  it("string third arg is still a profile, unchanged (backward compatible)", () => {
    const step = activity("kubectlApply", { manifest: "k8s.yaml" }, "longInfra");
    expect(step.profile).toBe("longInfra");
    expect(step.id).toBeUndefined();
  });
});

// ── collectStepOutputRefs() ─────────────────────────────────────────────────

describe("collectStepOutputRefs()", () => {
  it("finds a ref nested inside an object and an array", () => {
    const ref1 = stepOutput("diff", "a");
    const ref2 = stepOutput("diff", "b");
    const found = collectStepOutputRefs({ config: { stacks: [ref1, "literal", ref2] } });
    expect(found).toEqual([ref1, ref2]);
  });

  it("returns nothing for plain args", () => {
    expect(collectStepOutputRefs({ env: "prod", n: 1, list: [1, 2] })).toEqual([]);
  });
});

// ── validateStepOutputRefs() ─────────────────────────────────────────────────

describe("validateStepOutputRefs() — passing Ops", () => {
  it("a same-phase-later-step reference against a valid path passes", () => {
    const diff = activity("lifecycleDiff", { env: "prod" }, { id: "diff" });
    const apply = activity("applyStacks", { stacks: diff.out.driftedStacks });
    const config = opWith({ phases: [phase("Reconcile", [diff, apply])] });
    const contracts = new Map<string, ActivityContract>([
      ["lifecycleDiff", lifecycleDiffContract],
      ["applyStacks", applyStacksContract],
    ]);
    expect(validateStepOutputRefs(config, contracts)).toEqual([]);
  });

  it("a reference from a later phase passes", () => {
    const diff = activity("lifecycleDiff", { env: "prod" }, { id: "diff" });
    const apply = activity("applyStacks", { stacks: diff.out.driftedStacks });
    const config = opWith({ phases: [phase("Diff", [diff]), phase("Apply", [apply])] });
    const contracts = new Map<string, ActivityContract>([
      ["lifecycleDiff", lifecycleDiffContract],
      ["applyStacks", applyStacksContract],
    ]);
    expect(validateStepOutputRefs(config, contracts)).toEqual([]);
  });

  it("a whole-value reference (no path) passes even without checking the producer's return shape", () => {
    const diff = activity("lifecycleDiff", { env: "prod" }, { id: "diff" });
    const apply = activity("applyStacks", { stacks: stepOutput("diff") });
    const config = opWith({ phases: [phase("P", [diff, apply])] });
    const contracts = new Map<string, ActivityContract>([
      ["lifecycleDiff", lifecycleDiffContract],
      ["applyStacks", applyStacksContract],
    ]);
    expect(validateStepOutputRefs(config, contracts)).toEqual([]);
  });

  it("no refs anywhere — no issues", () => {
    const config = opWith({ phases: [phase("P", [activity("lifecycleDiff", { env: "prod" })])] });
    expect(validateStepOutputRefs(config, new Map())).toEqual([]);
  });
});

describe("validateStepOutputRefs() — the four failure classes from #1290", () => {
  it("flags a reference to an unknown producer step id", () => {
    const apply = activity("applyStacks", { stacks: stepOutput("nope", "driftedStacks") });
    const config = opWith({ phases: [phase("P", [apply])] });
    const issues = validateStepOutputRefs(config, new Map([["applyStacks", applyStacksContract]]));
    expect(issues.some((i) => i.message.includes('unknown step id "nope"'))).toBe(true);
  });

  it("flags a path that doesn't exist on the producer's declared return schema", () => {
    const diff = activity("lifecycleDiff", { env: "prod" }, { id: "diff" });
    const apply = activity("applyStacks", { stacks: stepOutput("diff", "notAField") });
    const config = opWith({ phases: [phase("P", [diff, apply])] });
    const contracts = new Map<string, ActivityContract>([
      ["lifecycleDiff", lifecycleDiffContract],
      ["applyStacks", applyStacksContract],
    ]);
    const issues = validateStepOutputRefs(config, contracts);
    expect(issues.some((i) => i.message.includes('path "notAField"') && i.message.includes("does not exist"))).toBe(true);
  });

  it("flags a reference to a later step", () => {
    const apply = activity("applyStacks", { stacks: stepOutput("diff", "driftedStacks") });
    const diff = activity("lifecycleDiff", { env: "prod" }, { id: "diff" });
    const config = opWith({ phases: [phase("Apply", [apply]), phase("Diff", [diff])] });
    const contracts = new Map<string, ActivityContract>([
      ["lifecycleDiff", lifecycleDiffContract],
      ["applyStacks", applyStacksContract],
    ]);
    const issues = validateStepOutputRefs(config, contracts);
    expect(issues.some((i) => i.message.includes("later phase"))).toBe(true);
  });

  it("flags a reference into a contract-less producer", () => {
    const diff = activity("lifecycleDiff", { env: "prod" }, { id: "diff" });
    const apply = activity("applyStacks", { stacks: stepOutput("diff", "driftedStacks") });
    const config = opWith({ phases: [phase("P", [diff, apply])] });
    // No contract registered for lifecycleDiff at all.
    const issues = validateStepOutputRefs(config, new Map([["applyStacks", applyStacksContract]]));
    expect(issues.some((i) => i.message.includes("no registered activity contract"))).toBe(true);
  });
});

describe("validateStepOutputRefs() — structural coverage", () => {
  it("flags a self-reference", () => {
    const step = activity("lifecycleDiff", { env: "prod" }, { id: "diff" });
    step.args = { env: "prod", x: stepOutput("diff", "drifted") };
    const config = opWith({ phases: [phase("P", [step])] });
    const issues = validateStepOutputRefs(config, new Map([["lifecycleDiff", lifecycleDiffContract]]));
    expect(issues.some((i) => i.message.includes("does not run before this step"))).toBe(true);
  });

  it("flags a reference to a step in the same parallel phase", () => {
    const diff = activity("lifecycleDiff", { env: "prod" }, { id: "diff" });
    const apply = activity("applyStacks", { stacks: stepOutput("diff", "driftedStacks") });
    const config = opWith({ phases: [phase("P", [diff, apply], { parallel: true })] });
    const contracts = new Map<string, ActivityContract>([
      ["lifecycleDiff", lifecycleDiffContract],
      ["applyStacks", applyStacksContract],
    ]);
    const issues = validateStepOutputRefs(config, contracts);
    expect(issues.some((i) => i.message.includes("same parallel phase"))).toBe(true);
  });

  it("flags a duplicate step id", () => {
    const diff1 = activity("lifecycleDiff", { env: "a" }, { id: "diff" });
    const diff2 = activity("lifecycleDiff", { env: "b" }, { id: "diff" });
    const apply = activity("applyStacks", { stacks: stepOutput("diff", "driftedStacks") });
    const config = opWith({ phases: [phase("P", [diff1, diff2, apply])] });
    const contracts = new Map<string, ActivityContract>([
      ["lifecycleDiff", lifecycleDiffContract],
      ["applyStacks", applyStacksContract],
    ]);
    const issues = validateStepOutputRefs(config, contracts);
    expect(issues.some((i) => i.message.includes("used by more than one step"))).toBe(true);
  });

  it("flags a producer contract with no returns schema", () => {
    const cmd = activity("shellCmd", { cmd: "true" }, { id: "cmd" });
    const apply = activity("applyStacks", { stacks: stepOutput("cmd", "x") });
    const config = opWith({ phases: [phase("P", [cmd, apply])] });
    const contracts = new Map<string, ActivityContract>([
      ["shellCmd", noReturnContract],
      ["applyStacks", applyStacksContract],
    ]);
    const issues = validateStepOutputRefs(config, contracts);
    expect(issues.some((i) => i.message.includes("declares no return schema"))).toBe(true);
  });

  it("flags a reference authored inside onFailure", () => {
    const diff = activity("lifecycleDiff", { env: "prod" }, { id: "diff" });
    const rollback = activity("applyStacks", { stacks: stepOutput("diff", "driftedStacks") });
    const config = opWith({ phases: [phase("P", [diff])], onFailure: [phase("Rollback", [rollback])] });
    const contracts = new Map<string, ActivityContract>([
      ["lifecycleDiff", lifecycleDiffContract],
      ["applyStacks", applyStacksContract],
    ]);
    const issues = validateStepOutputRefs(config, contracts);
    expect(issues.some((i) => i.message.includes("onFailure compensation"))).toBe(true);
  });

  it("flags a reference authored inside an effect step's nested steps", () => {
    const receipt = EffectReceipt("seeded", { effect: "db-seed", flavor: "hash", inputs: { file: "seed.sql", version: 3 } });
    const diff = activity("lifecycleDiff", { env: "prod" }, { id: "diff" });
    const nested = activity("applyStacks", { stacks: stepOutput("diff", "driftedStacks") });
    const effectStep = effect(receipt, [nested]);
    const config = opWith({ phases: [phase("P", [diff, effectStep])] });
    const contracts = new Map<string, ActivityContract>([
      ["lifecycleDiff", lifecycleDiffContract],
      ["applyStacks", applyStacksContract],
    ]);
    const issues = validateStepOutputRefs(config, contracts);
    expect(issues.some((i) => i.message.includes("nested inside an effect step"))).toBe(true);
  });

  it("reports every issue across multiple refs, not just the first", () => {
    const apply1 = activity("applyStacks", { stacks: stepOutput("nope1", "x") });
    const apply2 = activity("applyStacks", { stacks: stepOutput("nope2", "x") });
    const config = opWith({ phases: [phase("P", [apply1, apply2])] });
    const issues = validateStepOutputRefs(config, new Map([["applyStacks", applyStacksContract]]));
    expect(issues.some((i) => i.message.includes("nope1"))).toBe(true);
    expect(issues.some((i) => i.message.includes("nope2"))).toBe(true);
  });
});

// ── validateStepOutputRefs() — cross-contract primitive-type check (#1950-3) ──

describe("validateStepOutputRefs() — cross-contract type compatibility", () => {
  const takeCountContract = activityContract("takeCount", z.strictObject({ count: z.number() }));

  it("flags a string-returning path fed into a number-typed arg", () => {
    const diff = activity("lifecycleDiff", { env: "prod" }, { id: "diff" });
    const consume = activity("takeCount", { count: stepOutput("diff", "output") });
    const config = opWith({ phases: [phase("P", [diff, consume])] });
    const contracts = new Map<string, ActivityContract>([
      ["lifecycleDiff", lifecycleDiffContract],
      ["takeCount", takeCountContract],
    ]);
    const issues = validateStepOutputRefs(config, contracts);
    expect(issues.some((i) => i.message.includes("type mismatch") && i.message.includes("string") && i.message.includes("number"))).toBe(true);
  });

  it("a matching type (array of strings into array of strings) passes", () => {
    const diff = activity("lifecycleDiff", { env: "prod" }, { id: "diff" });
    const apply = activity("applyStacks", { stacks: stepOutput("diff", "driftedStacks") });
    const config = opWith({ phases: [phase("P", [diff, apply])] });
    const contracts = new Map<string, ActivityContract>([
      ["lifecycleDiff", lifecycleDiffContract],
      ["applyStacks", applyStacksContract],
    ]);
    expect(validateStepOutputRefs(config, contracts)).toEqual([]);
  });

  it("bails silently when the consumer has no registered contract", () => {
    const diff = activity("lifecycleDiff", { env: "prod" }, { id: "diff" });
    const consume = activity("takeCount", { count: stepOutput("diff", "output") });
    const config = opWith({ phases: [phase("P", [diff, consume])] });
    // No contract registered for "takeCount" — nothing to compare the consumer's arg type against.
    const issues = validateStepOutputRefs(config, new Map([["lifecycleDiff", lifecycleDiffContract]]));
    expect(issues.some((i) => i.message.includes("type mismatch"))).toBe(false);
  });

  it("bails silently on a whole-value reference (no path)", () => {
    const diff = activity("lifecycleDiff", { env: "prod" }, { id: "diff" });
    const consume = activity("takeCount", { count: stepOutput("diff") });
    const config = opWith({ phases: [phase("P", [diff, consume])] });
    const contracts = new Map<string, ActivityContract>([
      ["lifecycleDiff", lifecycleDiffContract],
      ["takeCount", takeCountContract],
    ]);
    expect(validateStepOutputRefs(config, contracts).some((i) => i.message.includes("type mismatch"))).toBe(false);
  });
});
