import { describe, test, expect } from "vitest";
import { isActivityContract, validateActivitySteps, validateStepOutputRefs, stepOutput, type ActivityContract } from "@intentius/chant/op";
import * as contracts from "./activity-contracts";
import * as activities from "./activities";

const CONTRACTS: Map<string, ActivityContract> = new Map(
  Object.values(contracts).filter(isActivityContract).map((c) => [c.name, c]),
);

/**
 * The activities this lexicon contributes to the run-time registry — every
 * exported function that is one, as `collectActivities` keys them.
 * `terraformInitCommand` and friends are pure builders the tests assert on,
 * not activities a step can name, so the list is spelled out rather than
 * derived from the module's exports.
 */
const ACTIVITY_NAMES = [
  "terraformInit",
  "terraformPlan",
  "terraformApply",
  "terraformShow",
  "choudoufuLivePlan",
  "choudoufuLiveLs",
  "choudoufuLiveCheck",
  "choudoufuAdopt",
];

describe("terraform activity contracts (#2101)", () => {
  test("every activity this lexicon ships has a contract", () => {
    for (const name of ACTIVITY_NAMES) {
      expect(CONTRACTS.get(name), `no contract declared for ${name}`).toBeDefined();
    }
  });

  test("each name in ACTIVITY_NAMES really is an exported activity", () => {
    for (const name of ACTIVITY_NAMES) {
      expect(typeof (activities as unknown as Record<string, unknown>)[name]).toBe("function");
    }
  });

  test("the module exports nothing but contracts", () => {
    for (const [key, value] of Object.entries(contracts)) {
      expect(isActivityContract(value), `${key} is not an ActivityContract`).toBe(true);
    }
  });

  test("every contract declares a return schema — OPS013 needs one to validate a reference", () => {
    for (const name of ACTIVITY_NAMES) {
      expect(CONTRACTS.get(name)?.returns, `${name} declares no return schema`).toBeDefined();
    }
  });

  test("`root` is declared as the entity every step touches (#2022)", () => {
    for (const name of ACTIVITY_NAMES) {
      expect(CONTRACTS.get(name)?.entities).toEqual(["root"]);
    }
  });

  // ── The failure classes the contracts exist to catch ───────────────────

  const op = (steps: unknown[]) => ({
    name: "app-apply",
    phases: [{ name: "Phase", steps: steps as never[] }],
  });

  test("a misspelled arg key is an error, not a silently dropped field", () => {
    const issues = validateActivitySteps(
      op([{ kind: "activity", fn: "terraformPlan", args: { root: "app", planfile: "chant.tfplan" } }]),
      CONTRACTS,
    );
    expect(issues.some((i) => i.message.includes("planfile"))).toBe(true);
  });

  test("a missing `root` is an error", () => {
    const issues = validateActivitySteps(
      op([{ kind: "activity", fn: "terraformApply", args: {} }]),
      CONTRACTS,
    );
    expect(issues.length).toBeGreaterThan(0);
  });

  test("the args the examples' composites build validate clean", () => {
    const issues = validateActivitySteps(
      op([
        { kind: "activity", fn: "terraformInit", args: { root: "app" }, profile: "longInfra" },
        { kind: "activity", fn: "terraformPlan", args: { root: "app", planFile: "chant.tfplan" }, id: "plan", profile: "longInfra" },
        { kind: "activity", fn: "terraformShow", args: { root: "app", planFile: stepOutput("plan", "planFile") }, profile: "fastIdempotent" },
        { kind: "activity", fn: "terraformApply", args: { root: "app", planFile: stepOutput("plan", "planFile") }, profile: "longInfra" },
      ]),
      CONTRACTS,
    );
    expect(issues).toEqual([]);
  });

  test("`plan.out.planFile` resolves against terraformPlan's declared return type", () => {
    const issues = validateStepOutputRefs(
      op([
        { kind: "activity", fn: "terraformPlan", args: { root: "app" }, id: "plan" },
        { kind: "activity", fn: "terraformApply", args: { root: "app", planFile: stepOutput("plan", "planFile") } },
      ]),
      CONTRACTS,
    );
    expect(issues).toEqual([]);
  });

  test("`plan.out.text` — the field a finding mode posts — resolves too", () => {
    const issues = validateStepOutputRefs(
      op([
        { kind: "activity", fn: "terraformPlan", args: { root: "app" }, id: "plan" },
        { kind: "activity", fn: "reconcilePr", args: { env: "app", body: stepOutput("plan", "text") } },
      ]),
      CONTRACTS,
    );
    expect(issues).toEqual([]);
  });

  test("a live watch's three outcome attributes exist on choudoufuLivePlan's return type", () => {
    const issues = validateActivitySteps(
      op([
        {
          kind: "activity",
          fn: "choudoufuLivePlan",
          args: { root: "app" },
          id: "plan",
          outcomeAttribute: [
            { name: "Drift", from: "drift" },
            { name: "Unowned", from: "unowned" },
            { name: "Adoptable", from: "adoptable" },
          ],
        },
      ]),
      CONTRACTS,
    );
    expect(issues).toEqual([]);
  });

  test("a reference into terraform's own `-json` document does not resolve, by design", () => {
    const issues = validateStepOutputRefs(
      op([
        { kind: "activity", fn: "terraformPlan", args: { root: "app" }, id: "plan" },
        { kind: "activity", fn: "reconcilePr", args: { env: "app", body: stepOutput("plan", "json.resource_changes") } },
      ]),
      CONTRACTS,
    );
    expect(issues.some((i) => i.message.includes("does not exist"))).toBe(true);
  });
});
