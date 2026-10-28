/**
 * `chant build --pr-loop` carries the merge (#4636), the responses and the
 * description check's service (#4629) into the generated pull request jobs,
 * and refuses a value the jobs would refuse on their own line.
 */
import { describe, expect, test } from "vitest";
import { prLoopFlagsProblem } from "./build";
import { prLoopJobs, prLoopPostJob, prCommentPreviewJob } from "../../components/pr-pipeline";
import { productPipelineJobs } from "../../components/product-pipeline";

const loop = { prLoop: true, applyBeforeMerge: true } as const;

describe("prLoopFlagsProblem", () => {
  test("a whole merge, respond and decide line holds", () => {
    expect(prLoopFlagsProblem({ ...loop, merge: "auto", mergeTokenEnv: "CHANT_MERGE_TOKEN", mergeMethod: "squash", respond: ["description=check"], decideBackend: "review", decideModel: "m-1" })).toBeUndefined();
    expect(prLoopFlagsProblem({ prLoop: true })).toBeUndefined();
    expect(prLoopFlagsProblem({ prLoop: true, merge: "manual" })).toBeUndefined();
  });

  test("the flags need --pr-loop", () => {
    expect(prLoopFlagsProblem({ respond: ["apply-failed=off"] })).toMatch(/--respond .*needs --pr-loop/);
    expect(prLoopFlagsProblem({ merge: "auto", mergeTokenEnv: "T" })).toMatch(/--merge, --merge-token-env .*need --pr-loop/);
  });

  test("the merge's values are refused by name", () => {
    expect(prLoopFlagsProblem({ ...loop, merge: "later" })).toMatch(/--merge takes manual or auto, not later/);
    expect(prLoopFlagsProblem({ ...loop, merge: "auto", mergeTokenEnv: "T", mergeMethod: "fast-forward" })).toMatch(/--merge-method takes merge, squash, rebase, not fast-forward/);
    expect(prLoopFlagsProblem({ ...loop, merge: "auto" })).toMatch(/--merge-token-env <VAR>/);
    expect(prLoopFlagsProblem({ ...loop, merge: "auto", mergeTokenEnv: "not a name" })).toMatch(/variable name/);
    expect(prLoopFlagsProblem({ prLoop: true, merge: "auto", mergeTokenEnv: "T" })).toMatch(/needs --apply-before-merge/);
    expect(prLoopFlagsProblem({ ...loop, mergeTokenEnv: "T" })).toMatch(/go with --merge auto/);
    expect(prLoopFlagsProblem({ ...loop, merge: "manual", mergeMethod: "squash" })).toMatch(/--merge manual/);
  });

  test("the responses and the decide service are refused by name", () => {
    expect(prLoopFlagsProblem({ prLoop: true, respond: ["wave-moved=off"] })).toMatch(/names no event "wave-moved"/);
    expect(prLoopFlagsProblem({ prLoop: true, respond: ["apply-failed=loud"] })).toMatch(/apply-failed takes triage or off/);
    expect(prLoopFlagsProblem({ prLoop: true, respond: ["description=check"], decideBackend: "review" })).toMatch(/--decide-backend <name> and --decide-model <id>/);
    expect(prLoopFlagsProblem({ prLoop: true, decideBackend: "review", decideModel: "m-1" })).toMatch(/go with --respond description=check/);
  });

  test("--target-dependents is refused, since the plan job plans with no target", () => {
    expect(prLoopFlagsProblem({ prLoop: true, targetDependents: true })).toMatch(/--target-dependents/);
  });
});

describe("the responses and the decide service in the pull request jobs", () => {
  const respond = { "apply-failed": "off", description: "check" } as const;
  const decide = { backend: "review", model: "m-1" };

  test("the apply job carries CHANT_RESPOND, before merge and on merge", () => {
    const [plan, early, record] = prLoopJobs("github", "prod", { applyBeforeMerge: true, respond, decide });
    expect(early!.env.CHANT_RESPOND).toBe("apply-failed=off,description=check");
    expect(early!.run.env.CHANT_RESPOND).toBe("apply-failed=off,description=check");
    expect(plan!.env.CHANT_RESPOND).toBeUndefined();
    expect(record!.env.CHANT_RESPOND).toBeUndefined();
    const [, green] = prLoopJobs("gitlab", "prod", { applyOnMerge: true, respond: { "apply-failed": "off" } });
    expect(green!.run.env.CHANT_RESPOND).toBe("apply-failed=off");
  });

  test("defaults set no variable", () => {
    const [, apply] = prLoopJobs("github", "prod", { applyBeforeMerge: true, respond: { "apply-failed": "triage" } });
    expect(apply!.env.CHANT_RESPOND).toBeUndefined();
  });

  test("the note job's line asks the decide service", () => {
    for (const forge of ["github", "gitlab"] as const) {
      const post = prLoopPostJob(forge, "prod", undefined, undefined, { respond, decide });
      expect(post.command).toMatch(/pr-post .* --decide-backend "review" --decide-model "m-1"$/);
      expect(post.env.CHANT_RESPOND).toBe("apply-failed=off,description=check");
    }
    expect(prLoopPostJob("github", "prod").command).not.toMatch(/--decide-backend/);
  });

  test("a description check with no service is refused", () => {
    expect(() => prLoopJobs("github", "prod", { respond: { description: "check" } })).toThrow(/decide/);
  });

  test("the comment preview's plan takes neither", () => {
    const preview = prCommentPreviewJob("github", "prod", { previewComment: true, respond, decide, refresh: true, words: { product: "plywood", stages: { plan: "preview", apply: "up" }, commands: { preview: "plan" } } });
    expect(preview!.plan.env.CHANT_RESPOND).toBeUndefined();
    expect(preview!.plan.command).toMatch(/--refresh/);
  });

  test("productPipelineJobs gives the same jobs as the loop", () => {
    const product = productPipelineJobs("github", "prod", { words: { product: "plywood" }, applyBeforeMerge: true, respond, decide });
    expect(product.post.command).toMatch(/--decide-backend "review" --decide-model "m-1"$/);
    expect(product.post.env.CHANT_RESPOND).toBe("apply-failed=off,description=check");
    expect(product.applyBeforeMerge!.env.CHANT_RESPOND).toBe("apply-failed=off,description=check");
    expect(() => productPipelineJobs("github", "prod", { words: { product: "plywood" }, applyBeforeMerge: true, respond: { description: "check" } })).toThrow(/decide/);
  });

  test("the merge reaches the apply job's lines", () => {
    const [, apply] = prLoopJobs("github", "prod", { applyBeforeMerge: true, applyMerge: { tokenEnv: "CHANT_MERGE_TOKEN", method: "squash" } });
    expect(apply!.command).toMatch(/pr-apply --before-merge --merge auto --merge-token-env CHANT_MERGE_TOKEN --merge-method squash/);
    expect(apply!.run.command).toMatch(/--apply-before-merge --merge auto --merge-token-env CHANT_MERGE_TOKEN --merge-method squash/);
  });
});
