/**
 * #4987 in the product pipeline: `applyStatus` and a product plan's
 * `staleNotes` come back in `waves.pipeline` for the generators, the stale
 * marking with one `--member` per plan target, and each target's note
 * carries the target branch's commit it was planned against.
 */
import { describe, expect, test } from "vitest";
import type { OpWavesSpec } from "../op/op-waves";
import { productPipelineJobs } from "./product-pipeline";

const words = { product: "terragucci", noun: ["root", "roots"] as [string, string], commands: { plan: "plan" as const, apply: "apply" as const }, approval: "per-wave" as const, op: "tf-apply", bin: "npx --no-install terragucci" };
const waves: OpWavesSpec = { name: "tf-apply", op: "tf-apply", step: { kind: "terraform-apply", root: "{target}" }, waves: [{ name: "dev", runs: [{ target: "envs/dev" }] }] } as OpWavesSpec;
const productPlan = { command: "terragucci plan {target} --out {output}", workflow: "terragucci-pr", targets: [{ name: "dev" }, { name: "prod" }] };
const base = { words, waves, productPlan, staleNotes: true, applyStatus: true };

describe("the apply statuses and the stale notes in the product pipeline (#4987)", () => {
  test.each(["github", "forgejo", "gitlab"] as const)("on %s, the waves get the status context and the stale marking per target", (forge) => {
    const jobs = productPipelineJobs(forge, "default", base);
    expect(jobs.waves!.pipeline.applyStatus).toEqual({ context: "terragucci/apply" });
    const stale = jobs.waves!.pipeline.staleNotes!;
    expect(stale.command).toBe(`npx --no-install terragucci components pr-post --stale --tip "$TIP_SHA" --env default --forge ${forge} --member dev --member prod`);
    expect(stale.env.TIP_SHA).toBe(forge === "gitlab" ? "$CI_COMMIT_SHA" : "${{ github.sha }}");
    // The pull request loop's own stale job is not the product plan's.
    expect(jobs.stale).toBeUndefined();
    // Each target's note carries the target branch's commit, so the push can tell it is stale.
    for (const p of jobs.productPlan!) {
      expect(p.post.command).toContain('--tip "$TIP_SHA"');
      expect(p.post.env.TIP_SHA).toBe(forge === "gitlab" ? "$CI_COMMIT_SHA" : "${{ github.event.pull_request.base.sha }}");
    }
  });

  test("the re-plan's note carries its tip too, and the stale line names the re-plan comment", () => {
    const jobs = productPipelineJobs("github", "default", { ...base, productPlan: { ...productPlan, replan: true } });
    const replan = jobs.productPlan![0]!.replan!;
    expect(replan.post.command).toContain('--tip "$TIP_SHA"');
    expect(replan.post.env.TIP_SHA).toBe("${{ github.sha }}");
    expect(jobs.waves!.pipeline.staleNotes!.command).toContain("--preview-comment");
  });

  test("a member's status context, and nothing without the options", () => {
    expect(productPipelineJobs("github", "default", { ...base, member: "net" }).waves!.pipeline.applyStatus).toEqual({ context: "terragucci/apply/net" });
    expect(productPipelineJobs("github", "default", { words, waves, productPlan }).waves!.pipeline).toEqual({});
  });

  test("refused without waves", () => {
    const planOnly = { ...words, commands: { plan: "plan" as const } };
    expect(() => productPipelineJobs("github", "default", { words: planOnly, productPlan, applyStatus: true })).toThrow("applyStatus posts the waves' apply statuses, and there are none");
    expect(() => productPipelineJobs("github", "default", { words: planOnly, productPlan, staleNotes: true })).toThrow("staleNotes with the product plan marks the notes from the waves workflow's push run");
  });
});
