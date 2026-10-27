import { describe, expect, test } from "vitest";
import { componentWavesSpec, productPipelineJobs, productWavesSpec } from "./product-pipeline";
import { prApplyComment, prLoopSetup, PR_LOOP_IMAGE, PR_LOOP_SETUP, withProductBin } from "./pr-pipeline";
import { PLYWOOD, TERRAGUCCI } from "../__fixtures__/product-words";
import type { OpWavesSpec } from "../op/op-waves";

const waves: OpWavesSpec = {
  name: "apply",
  op: "apply",
  planWave: ["chant", "components", "plan-wave", "{runs}", "{plans}"],
  applyWave: ["chant", "components", "apply-wave", "{runs}", "{plans}"],
  waves: [
    { name: "dev", runs: [{ target: "shop-dev" }] },
    { name: "prod", runs: [{ target: "shop-prod" }] },
  ],
};

describe("the product pipeline (#4550)", () => {
  test("terragucci's and plywood's jobs differ only in the words each passes", () => {
    const tg = productPipelineJobs("github", "production", { words: TERRAGUCCI, waves, applyBeforeMerge: false, locks: "plan", agent: true });
    const pw = productPipelineJobs("github", "production", { words: PLYWOOD, waves, locks: "plan" });
    const shape = (j: typeof tg) => ({ plan: Object.keys(j.plan.env).sort(), waves: j.waves!.jobs.map((w) => w.jobName) });
    expect(shape(tg)).toEqual(shape(pw));
    expect(tg.waves!.spec.name).toBe("tf-apply");
    expect(pw.waves!.spec.name).toBe("pulumi-up");
    expect(tg.waves!.spec.gateName).toBe("wave-{k}");
    expect(pw.waves!.spec.gateName).toBe("wave-{k}");
  });

  test("the plan side runs the product's bin, and ci run passes it on", () => {
    const pw = productPipelineJobs("github", "production", { words: PLYWOOD });
    expect(pw.plan.command.startsWith("npx --no-install plywood components pr-plan ")).toBe(true);
    expect(pw.plan.command).toContain("--gate up");
    expect(pw.plan.run.command.startsWith('npx --no-install plywood ci run plan --chant "npx --no-install plywood" --in-place')).toBe(true);
    expect(pw.post.command.startsWith("npx --no-install plywood components pr-post ")).toBe(true);
    expect(pw.record).toBeDefined();
    expect(pw.waves).toBeUndefined();
  });

  test("the apply on merge runs on op waves through the product's bin", () => {
    const pw = productPipelineJobs("github", "production", { words: PLYWOOD, waves });
    expect(pw.record).toBeUndefined();
    expect(pw.waves!.specFile).toBe(".chant/op-waves/pulumi-up.spec.json");
    expect(pw.waves!.jobs[0]!.command.slice(0, 6)).toEqual(["npx", "--no-install", "plywood", "run", "wave", "--spec"]);
    expect(pw.comments).toEqual({ apply: "/plywood up" });
  });

  test("the approval preset: per wave for terragucci, the pull request's digest for plywood", () => {
    const tg = productWavesSpec(waves, TERRAGUCCI);
    expect(tg.waves.every((w) => w.approval === undefined)).toBe(true);
    expect(tg.approvals?.pullRequest).toBeUndefined();
    const pw = productWavesSpec(waves, PLYWOOD);
    expect(pw.waves.every((w) => w.approval === "pull-request")).toBe(true);
    expect(pw.approvals?.pullRequest).toEqual({ gate: "up" });
  });

  test("a command with no job is refused", () => {
    expect(() => productPipelineJobs("github", "production", { words: TERRAGUCCI })).toThrow(/needs a apply job/);
  });

  test("the component graph gives the waves pr-apply --wave-gate runs on op waves", () => {
    const spec = componentWavesSpec(
      [{ name: "net", dependsOn: [] }, { name: "app", dependsOn: ["net"] }],
      PLYWOOD,
      { planWave: ["chant", "components", "plan-wave", "{runs}", "{plans}"], applyWave: ["chant", "components", "apply-wave", "{runs}", "{plans}"] },
    );
    expect(spec.name).toBe("pulumi-up");
    expect(spec.waves.map((w) => w.runs.map((r) => r.target))).toEqual([["net"], ["app"]]);
  });

  test("the comment, the bin and the engine lines", () => {
    expect(prApplyComment()).toBe("/chant apply");
    expect(prApplyComment({ words: PLYWOOD })).toBe("/plywood up");
    expect(withProductBin('git fetch && GREEN_SHA="$(chant ci last-green)"', "npx plywood")).toBe('git fetch && GREEN_SHA="$(npx plywood ci last-green)"');
    expect(withProductBin("chant/lifecycle stays", "npx plywood")).toBe("chant/lifecycle stays");
    expect(prLoopSetup(PR_LOOP_IMAGE)).toEqual(PR_LOOP_SETUP);
    expect(prLoopSetup(PR_LOOP_IMAGE, ["install pulumi"])).toEqual(["install pulumi"]);
    expect(prLoopSetup("my/image", ["install pulumi"])).toEqual([]);
  });
});
