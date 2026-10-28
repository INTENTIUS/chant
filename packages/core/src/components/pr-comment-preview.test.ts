/**
 * The comment preview (#4620): with `previewComment`, `/<product> <plan
 * word>` runs pr-plan again at the pull request's head with a read token,
 * and the job after it posts the note. productPipelineJobs returns the same
 * jobs the forge lexicons write.
 */

import { describe, expect, test } from "vitest";
import { GITLAB_PREVIEW_PR_VAR, prCommentPreviewJob } from "./pr-pipeline";
import { productPipelineJobs } from "./product-pipeline";

const WORDS = { product: "plywood", stages: { plan: "preview", apply: "up" }, commands: { preview: "plan" as const }, bin: "npx --no-install plywood" };

describe("prCommentPreviewJob", () => {
  test("none without previewComment", () => {
    expect(prCommentPreviewJob("github", "prod", { words: WORDS })).toBeUndefined();
  });

  test("GitHub: the comment from the words, the issue's number, the head ref, and the base from the target branch", () => {
    const job = prCommentPreviewJob("github", "prod", { words: WORDS, previewComment: true })!;
    expect(job.comment).toBe("/plywood preview");
    expect(job.plan.run.env.PR_NUMBER).toBe("${{ github.event.issue.number }}");
    expect(job.plan.run.env.BASE_SHA).toBeUndefined();
    expect(job.plan.run.command).toContain("npx --no-install plywood ci run plan");
    expect(job.plan.run.env.GITHUB_TOKEN).toBeUndefined();
    expect(job.head).toEqual({ ref: "refs/pull/${{ github.event.issue.number }}/head" });
    expect(job.base).toContain('refs/remotes/origin/main^{commit}');
    expect(job.post.command).toBe('npx --no-install plywood components pr-post --pr "$PR_NUMBER" --head "$HEAD_SHA" --env prod --output .chant/pr --forge github --result "$PLAN_RESULT"');
    expect(job.post.env.HEAD_SHA).toBe("${{ needs.comment-preview.outputs.head }}");
  });

  test("GitLab: the iid from CHANT_PREVIEW_PR, the head checked out in the job, and the post finds the head again", () => {
    const job = prCommentPreviewJob("gitlab", "prod", { words: WORDS, previewComment: true })!;
    expect(job.gitlabVar).toBe(GITLAB_PREVIEW_PR_VAR);
    expect(job.plan.run.env.PR_NUMBER).toBe("$CHANT_PREVIEW_PR");
    expect(job.plan.run.env.BASE_SHA).toBe("$CI_COMMIT_SHA");
    expect(job.head).toEqual({ line: expect.stringContaining("refs/merge-requests/$PR_NUMBER/head") });
    expect(job.post.setup?.[0]).toContain("git ls-remote origin");
    expect(job.post.command).not.toContain("--result");
  });

  test("words with no plan command are refused", () => {
    expect(() => prCommentPreviewJob("github", "prod", { words: { product: "plywood", commands: {} }, previewComment: true })).toThrow(/the words name no plan command/);
  });
});

describe("productPipelineJobs with previewComment", () => {
  test("returns the preview beside the plan, and nothing without it", () => {
    const jobs = productPipelineJobs("github", "prod", { words: WORDS, previewComment: true });
    expect(jobs.preview?.comment).toBe("/plywood preview");
    expect(jobs.comments.plan).toBe("/plywood preview");
    expect(productPipelineJobs("github", "prod", { words: WORDS }).preview).toBeUndefined();
  });
});
