/**
 * Activity contract tests (chant #1288 Stage 1).
 *
 * Exercises the four failure classes named in the issue, using a small
 * lifecycleDiff-shaped contract so the test doesn't need a real lexicon.
 */

import { describe, expect, it } from "vitest";
import { z } from "zod";
import { activity, phase, effect } from "./builders";
import type { OpConfig } from "./types";
import {
  activityContract,
  isActivityContract,
  collectActivityContracts,
  validateActivitySteps,
  type ActivityContract,
} from "./activity-contract";
import { EffectReceipt } from "../effect-receipt";

// ── activityContract() / isActivityContract() ──────────────────────────────

describe("activityContract()", () => {
  it("brands its result so isActivityContract recognizes it", () => {
    const contract = activityContract("noop", z.strictObject({}));
    expect(isActivityContract(contract)).toBe(true);
    expect(contract.name).toBe("noop");
  });

  it("isActivityContract rejects a plain object with the same shape", () => {
    expect(isActivityContract({ name: "noop", args: z.strictObject({}) })).toBe(false);
    expect(isActivityContract(null)).toBe(false);
    expect(isActivityContract(undefined)).toBe(false);
  });
});

describe("collectActivityContracts()", () => {
  it("collects every exported contract, keyed by its declared name — ignores non-contract exports", () => {
    const mod = {
      shellCmdContract: activityContract("shellCmd", z.strictObject({ cmd: z.string() })),
      httpCheckContract: activityContract("httpCheck", z.strictObject({ url: z.string() })),
      unrelatedExport: "not a contract",
      SOME_CONSTANT: 42,
    };
    const into = new Map<string, ActivityContract>();
    collectActivityContracts(mod, into);
    expect([...into.keys()].sort()).toEqual(["httpCheck", "shellCmd"]);
    expect(into.get("shellCmd")!.name).toBe("shellCmd");
  });
});

// ── validateActivitySteps() ─────────────────────────────────────────────────

const lifecycleDiffContract = activityContract(
  "lifecycleDiff",
  z.strictObject({ env: z.string(), live: z.boolean().optional() }),
  z.object({ output: z.string(), exitCode: z.number(), drifted: z.boolean() }),
);

const helmInstallContract = activityContract(
  "helmInstall",
  z.strictObject({ name: z.string(), chart: z.string().optional(), namespace: z.string().optional() }),
);

function opWith(config: Partial<OpConfig> & Pick<OpConfig, "phases">): Pick<OpConfig, "name" | "phases" | "onFailure"> {
  return { name: "test-op", ...config };
}

describe("validateActivitySteps() — passing Ops", () => {
  it("returns no issues for a step matching its contract exactly", () => {
    const config = opWith({ phases: [phase("Diff", [activity("lifecycleDiff", { env: "prod", live: true })])] });
    const issues = validateActivitySteps(config, new Map([["lifecycleDiff", lifecycleDiffContract]]));
    expect(issues).toEqual([]);
  });

  it("skips a step whose fn has no registered contract — non-breaking by design", () => {
    const config = opWith({ phases: [phase("Deploy", [activity("somethingUnregistered", { anything: "goes" })])] });
    const issues = validateActivitySteps(config, new Map([["lifecycleDiff", lifecycleDiffContract]]));
    expect(issues).toEqual([]);
  });

  it("a valid outcomeAttribute.from path against the declared return schema passes", () => {
    const step = activity("lifecycleDiff", { env: "prod" });
    step.outcomeAttribute = { name: "Drift", from: "drifted" };
    const config = opWith({ phases: [phase("Diff", [step])] });
    const issues = validateActivitySteps(config, new Map([["lifecycleDiff", lifecycleDiffContract]]));
    expect(issues).toEqual([]);
  });
});

describe("validateActivitySteps() — the four failure classes from #1288", () => {
  it("flags an unknown profile — e.g. kubectlApply(..., { profile: \"longInfa\" })", () => {
    const step = activity("kubectlApply", { manifest: "dist/k8s.yaml" }, "longInfa" as never);
    const config = opWith({ phases: [phase("Deploy", [step])] });
    const issues = validateActivitySteps(config, new Map());
    expect(issues).toHaveLength(1);
    expect(issues[0].message).toContain('unknown profile "longInfa"');
    expect(issues[0].message).toContain("fastIdempotent");
  });

  it("flags an arg key the schema doesn't recognize — e.g. helmInstall(..., { nameSpace: \"prod\" })", () => {
    const step = activity("helmInstall", { name: "api", chart: "./chart", nameSpace: "prod" });
    const config = opWith({ phases: [phase("Deploy", [step])] });
    const issues = validateActivitySteps(config, new Map([["helmInstall", helmInstallContract]]));
    expect(issues.some((i) => i.message.includes("Unrecognized key") && i.message.includes("nameSpace"))).toBe(true);
  });

  it("flags a wrong/missing arg key — e.g. activity(\"lifecycleDiff\", { environment: \"prod\" })", () => {
    const step = activity("lifecycleDiff", { environment: "prod" });
    const config = opWith({ phases: [phase("Diff", [step])] });
    const issues = validateActivitySteps(config, new Map([["lifecycleDiff", lifecycleDiffContract]]));
    // `env` (required) is missing, and `environment` is an unrecognized key.
    expect(issues.some((i) => i.message.includes("args.env"))).toBe(true);
    expect(issues.some((i) => i.message.includes("Unrecognized key") && i.message.includes("environment"))).toBe(true);
  });

  it("flags an outcomeAttribute.from path that doesn't exist on the declared return type", () => {
    const step = activity("lifecycleDiff", { env: "prod" });
    step.outcomeAttribute = { name: "Drift", from: "drifed" }; // typo: drifted
    const config = opWith({ phases: [phase("Diff", [step])] });
    const issues = validateActivitySteps(config, new Map([["lifecycleDiff", lifecycleDiffContract]]));
    expect(issues.some((i) => i.message.includes('outcomeAttribute.from "drifed"'))).toBe(true);
  });

  it("flags a wrong-typed arg value even when the key is right", () => {
    const step = activity("lifecycleDiff", { env: 42 as unknown as string });
    const config = opWith({ phases: [phase("Diff", [step])] });
    const issues = validateActivitySteps(config, new Map([["lifecycleDiff", lifecycleDiffContract]]));
    expect(issues.some((i) => i.message.includes("args.env"))).toBe(true);
  });
});

describe("validateActivitySteps() — structural coverage", () => {
  it("walks onFailure phases too", () => {
    const step = activity("lifecycleDiff", { environment: "prod" });
    const config = opWith({ phases: [], onFailure: [phase("Rollback", [step])] });
    const issues = validateActivitySteps(config, new Map([["lifecycleDiff", lifecycleDiffContract]]));
    expect(issues.length).toBeGreaterThan(0);
  });

  it("walks activity steps nested inside an effect step", () => {
    const receipt = EffectReceipt("seeded", {
      effect: "db-seed",
      flavor: "hash",
      inputs: { file: "seed.sql", version: 3 },
    });
    const badStep = activity("lifecycleDiff", { environment: "prod" });
    const effectStep = effect(receipt, [badStep]);
    const config = opWith({ phases: [phase("Seed", [effectStep])] });
    const issues = validateActivitySteps(config, new Map([["lifecycleDiff", lifecycleDiffContract]]));
    expect(issues.length).toBeGreaterThan(0);
  });

  it("reports every issue across multiple steps, not just the first", () => {
    const step1 = activity("lifecycleDiff", { environment: "prod" });
    const step2 = activity("kubectlApply", {}, "longInfa" as never);
    const config = opWith({ phases: [phase("P", [step1, step2])] });
    const issues = validateActivitySteps(config, new Map([["lifecycleDiff", lifecycleDiffContract]]));
    expect(issues.some((i) => i.fn === "lifecycleDiff")).toBe(true);
    expect(issues.some((i) => i.fn === "kubectlApply")).toBe(true);
  });
});
