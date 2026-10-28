/**
 * The pull request loop's runners, variables, passed secrets and plan
 * parallelism (#4625), in the job descriptors and through
 * productPipelineJobs. Written for the ci-products post-merge pass.
 */

import { describe, expect, test } from "vitest";
import { prLoopJobs, prLoopJobStage, prLoopPassedEnv, prLoopRunner, prCommentPreviewJob } from "./pr-pipeline";
import { productPipelineJobs } from "./product-pipeline";
import { PLYWOOD } from "../__fixtures__/product-words";
import type { OpWavesSpec } from "../op/op-waves";

describe("runners by stage (#4625)", () => {
  test("a stage's own runner, else the default", () => {
    const runners = { plan: "big", default: ["self-hosted", "small"] };
    expect(prLoopRunner({ runners }, "plan")).toBe("big");
    expect(prLoopRunner({ runners }, "apply")).toEqual(["self-hosted", "small"]);
    expect(prLoopRunner({}, "plan")).toBeUndefined();
  });

  test("the plan, apply and record descriptors carry their stage's runner", () => {
    const [plan, apply, record] = prLoopJobs("github", "prod", { runners: { plan: "p", apply: "a" }, applyOnMerge: true });
    expect(plan!.runner).toBe("p");
    expect(apply!.runner).toBe("a");
    expect(record!.runner).toBe("a");
  });

  test("job names map onto stages, a member's prefix taken off", () => {
    expect(prLoopJobStage("plan")).toBe("plan");
    expect(prLoopJobStage("comment-preview")).toBe("plan");
    expect(prLoopJobStage("apply-wave-2")).toBe("apply");
    expect(prLoopJobStage("shop-record", "shop")).toBe("apply");
    expect(prLoopJobStage("plan-note")).toBe("default");
    expect(prLoopJobStage("comment-lock")).toBe("default");
  });
});

describe("variables and passed secrets (#4625)", () => {
  test("GitHub maps a secret from secrets.<name>; GitLab only when the names differ", () => {
    expect(prLoopPassedEnv("github", { variables: { REGION: "eu" }, secrets: { DB_PASSWORD: "PROD_DB" } })).toEqual({ REGION: "eu", DB_PASSWORD: "${{ secrets.PROD_DB }}" });
    expect(prLoopPassedEnv("gitlab", { secrets: { DB_PASSWORD: "PROD_DB", SAME: "SAME" } })).toEqual({ DB_PASSWORD: "$PROD_DB" });
  });

  test("a forge token or a name the jobs set is refused", () => {
    expect(() => prLoopPassedEnv("github", { secrets: { GITHUB_TOKEN: "PAT" } })).toThrow(/drops the forge tokens/);
    expect(() => prLoopPassedEnv("github", { variables: { BASE_SHA: "x" } })).toThrow(/set or drop themselves/);
    expect(() => prLoopPassedEnv("github", { variables: { "not a name": "x" } })).toThrow(/not a variable name/);
  });

  test("they reach the plan and the apply, and the plan still holds no forge token", () => {
    const [plan, apply] = prLoopJobs("github", "prod", { variables: { REGION: "eu" }, secrets: { DB_PASSWORD: "PROD_DB" }, applyOnMerge: true });
    expect(plan!.env).toMatchObject({ REGION: "eu", DB_PASSWORD: "${{ secrets.PROD_DB }}" });
    expect(plan!.env).not.toHaveProperty("GITHUB_TOKEN");
    expect(plan!.run.env).not.toHaveProperty("GITHUB_TOKEN");
    expect(apply!.env).toMatchObject({ REGION: "eu", DB_PASSWORD: "${{ secrets.PROD_DB }}", GITHUB_TOKEN: "${{ github.token }}" });
  });

  test("the comment preview's plan gets them too", () => {
    const preview = prCommentPreviewJob("github", "prod", { previewComment: true, variables: { REGION: "eu" }, words: PLYWOOD });
    expect(preview!.plan.env).toMatchObject({ REGION: "eu" });
  });
});

describe("parallelism (#4625)", () => {
  test("the plan runs pr-plan --parallelism, and ci run passes it on", () => {
    const [plan] = prLoopJobs("github", "prod", { parallelism: 4 });
    expect(plan!.command).toContain("--parallelism 4");
    expect(plan!.run.command).toContain("--parallelism 4");
    expect(() => prLoopJobs("github", "prod", { parallelism: 0 })).toThrow(/whole number/);
  });

  test("productPipelineJobs puts the apply runner and the parallelism on a step spec that names neither", () => {
    const waves: OpWavesSpec = { name: "up", op: "pulumi-up", step: { kind: "pulumi-up", stack: "{target}" }, waves: [{ name: "dev", runs: [{ target: "dev" }] }] };
    const jobs = productPipelineJobs("github", "prod", { words: PLYWOOD, waves, locks: "plan", runners: { apply: "deployer", default: "small" }, parallelism: 3 });
    expect(jobs.waves!.spec).toMatchObject({ runner: "deployer", parallelism: 3 });
    expect(jobs.post.runner).toBe("small");
    const own = productPipelineJobs("github", "prod", { words: PLYWOOD, waves: { ...waves, runner: "mine", parallelism: 1 }, locks: "plan", runners: { apply: "deployer" }, parallelism: 3 });
    expect(own.waves!.spec).toMatchObject({ runner: "mine", parallelism: 1 });
  });
});
