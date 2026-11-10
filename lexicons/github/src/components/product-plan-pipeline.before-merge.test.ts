/**
 * The product pipeline's waves before merge (#4984): the comment job
 * (GitHub, Forgejo) and the note poll (GitLab) are told the waves workflow,
 * the plan statuses, the pipeline files and the lock file, with the reach
 * line; the waves come back with the generator's before-merge mode.
 */
import { describe, expect, test } from "vitest";
import type { OpWavesSpec } from "@intentius/chant/op/op-waves";
import { productPipelineJobs } from "@intentius/chant/components/product-pipeline";
import { generateProductPlanPipeline } from "./product-plan-pipeline";
import { generateGitlabProductPlanPipeline } from "../../../gitlab/src/components/product-plan-pipeline";

const words = { product: "terragucci", noun: ["root", "roots"] as [string, string], commands: { plan: "plan" as const, apply: "apply" as const, lock: "lock" as const, unlock: "unlock" as const }, approval: "per-wave" as const, op: "tf-apply", bin: "npx --no-install terragucci" };
const waves: OpWavesSpec = { name: "tf-apply", op: "tf-apply", step: { kind: "terraform-apply", root: "{target}" }, waves: [{ name: "dev", runs: [{ target: "envs/dev" }] }, { name: "prod", runs: [{ target: "envs/prod" }] }] } as OpWavesSpec;
const reach = { command: "terragucci reached", gate: "tf-apply" };
const base = { words, waves, locks: "plan" as const, productPlan: { command: "terragucci plan --out {output}", workflow: "terragucci-pr", reach, replan: true } };

type Job = { permissions?: Record<string, string>; steps: Array<{ env?: Record<string, string>; with?: Record<string, unknown> }>; variables?: Record<string, string> };

describe("the waves before merge in the product pipeline (#4984)", () => {
  test("GitHub: the comment job decides, with the waves workflow, the plan status, the pipeline files and the reach line", () => {
    const { doc, jobs } = generateProductPlanPipeline("default", { ...base, commentJob: true, wavesBeforeMerge: { requires: ["approved", "checks"], merge: "auto" } });
    const comment = doc.jobsDoc.comment as Job;
    const env = comment.steps.at(-1)!.env!;
    expect(JSON.parse(env.CHANT_COMMENT_JOBS!)).toMatchObject({
      applyOnMerge: true,
      waves: { op: "tf-apply", count: 2 },
      wavesBeforeMerge: { workflow: "tf-apply.yml", requires: ["approved", "checks"], plan: ["terragucci/plan"], pipelineFiles: [".github/workflows/", ".chant/op-waves/"], locks: { gate: "tf-apply" } },
    });
    expect(env.CHANT_LOCK_REACH).toBe("terragucci reached");
    expect(comment.permissions).toEqual({ actions: "write", contents: "write", "pull-requests": "write", statuses: "read", checks: "read" });
    expect(comment.steps[0]!.with).toEqual({ "fetch-depth": 0 });
    expect(jobs.waves!.beforeMerge).toEqual({ merge: "auto", gate: "tf-apply" });
  });

  test("GitLab: the note poll is told the waves, and decides the waves before merge", () => {
    const jobs = productPipelineJobs("gitlab", "default", { ...base, noteCommands: true, wavesBeforeMerge: {} });
    const env = jobs.noteCommands!.env!;
    expect(JSON.parse(env.CHANT_COMMENT_JOBS!)).toEqual({ waves: { op: "tf-apply", count: 2 }, wavesBeforeMerge: { plan: ["terragucci/plan"], pipelineFiles: [".gitlab-ci.yml", ".gitlab/", ".chant/op-waves/"], locks: { gate: "tf-apply" } } });
    expect(env.CHANT_LOCK_REACH).toBe("terragucci reached");
    const yaml = generateGitlabProductPlanPipeline("default", { ...base, noteCommands: true, wavesBeforeMerge: {} });
    expect(yaml.yaml).toContain("CHANT_COMMENT_JOBS");
    // Waves without the mode still give the poll their op and count, for a merged merge request's wave-<n>.
    expect(JSON.parse(productPipelineJobs("gitlab", "default", { ...base, noteCommands: true }).noteCommands!.env!.CHANT_COMMENT_JOBS!)).toEqual({ waves: { op: "tf-apply", count: 2 } });
  });

  test("refused without waves, beside applyBeforeMerge, and without the job that decides it", () => {
    expect(() => productPipelineJobs("github", "default", { ...base, waves: undefined, commentJob: true, wavesBeforeMerge: {} })).toThrow("wavesBeforeMerge runs the waves on an open pull request's head, and there are none");
    expect(() => productPipelineJobs("github", "default", { ...base, wavesBeforeMerge: {} })).toThrow("wavesBeforeMerge is decided by the comment job: set commentJob");
    expect(() => productPipelineJobs("gitlab", "default", { ...base, wavesBeforeMerge: {} })).toThrow("the note poll: set noteCommands");
  });
});
