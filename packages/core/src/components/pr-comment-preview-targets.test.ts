/**
 * The comment preview passes the comment's --target addresses to pr-plan
 * (#4626): `pr-plan --comment-targets`, with the comment in
 * CHANT_PREVIEW_COMMENT on GitHub and Forgejo and from the pipeline's
 * variable on GitLab. Written for the ci-products post-merge pass.
 */
import { describe, expect, test } from "vitest";
import { PREVIEW_COMMENT_ENV, prCommentPreviewJob, prLoopJobs } from "./pr-pipeline";
import { PLYWOOD } from "../__fixtures__/product-words";

const words = { ...PLYWOOD, commands: { preview: "plan" as const } };

describe("the comment preview's targets (#4626)", () => {
  test("GitHub and Forgejo: the plan reads the comment from a variable, never the shell line", () => {
    for (const forge of ["github", "forgejo"] as const) {
      const job = prCommentPreviewJob(forge, "prod", { previewComment: true, words }, undefined)!;
      expect(job.plan.command).toContain("--comment-targets");
      expect(job.plan.run.command).toContain("--comment-targets");
      expect(job.plan.run.env[PREVIEW_COMMENT_ENV]).toBe("${{ github.event.comment.body }}");
      expect(job.plan.run.command).not.toContain("comment.body");
    }
  });

  test("GitLab: the plan reads the pipeline's own variable", () => {
    const job = prCommentPreviewJob("gitlab", "prod", { previewComment: true, words }, undefined)!;
    expect(job.plan.run.command).toContain("--comment-targets");
    expect(job.plan.run.env).not.toHaveProperty(PREVIEW_COMMENT_ENV);
  });

  test("the pull request's own plan job reads no comment", () => {
    const [plan] = prLoopJobs("github", "prod", { words });
    expect(plan!.command).not.toContain("--comment-targets");
  });
});
