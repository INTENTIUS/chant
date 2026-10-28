/**
 * The stale job's descriptor (#4628): `prStaleJob` on the three forges, the
 * note job's tip, and productPipelineJobs returning both. Written for the
 * ci-products post-merge pass.
 */
import { describe, expect, test } from "vitest";
import { prLoopPostJob, prStaleJob } from "./pr-pipeline";
import { productPipelineJobs } from "./product-pipeline";
import { PLYWOOD } from "../__fixtures__/product-words";

describe("the stale job (#4628)", () => {
  test("none without staleNotes", () => {
    expect(prStaleJob("github", "prod", {})).toBeUndefined();
  });

  test("GitHub and Forgejo read the pushed commit; GitLab the pipeline's", () => {
    expect(prStaleJob("github", "prod", { staleNotes: true })).toEqual({ command: 'chant components pr-post --stale --tip "$TIP_SHA" --env prod --forge github', env: { TIP_SHA: "${{ github.sha }}", GITHUB_TOKEN: "${{ github.token }}" } });
    expect(prStaleJob("forgejo", "prod", { staleNotes: true, branch: "trunk" }, "shop")!.command).toBe('chant components pr-post --stale --tip "$TIP_SHA" --env prod --forge forgejo --branch "trunk" --member shop');
    expect(prStaleJob("gitlab", "prod", { staleNotes: true })!.env).toEqual({ TIP_SHA: "$CI_COMMIT_SHA" });
  });

  test("the note job passes the tip only with staleNotes", () => {
    expect(prLoopPostJob("github", "prod").command).not.toContain("--tip");
    expect(prLoopPostJob("github", "prod", undefined, undefined, { staleNotes: true }).env.TIP_SHA).toBe("${{ github.event.pull_request.base.sha }}");
    expect(prLoopPostJob("gitlab", "prod", undefined, undefined, { staleNotes: true }).command).toContain('--tip "$TIP_SHA"');
  });

  test("productPipelineJobs returns the stale job in the product's bin, naming the preview comment", () => {
    const words = { ...PLYWOOD, commands: { preview: "plan" as const } };
    const jobs = productPipelineJobs("github", "prod", { words, staleNotes: true, previewComment: true });
    expect(jobs.stale!.command).toBe('npx --no-install plywood components pr-post --stale --tip "$TIP_SHA" --env prod --forge github --preview-comment');
    expect(jobs.post.command).toContain('--tip "$TIP_SHA"');
  });
});
