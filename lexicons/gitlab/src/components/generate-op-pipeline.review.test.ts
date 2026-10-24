/**
 * `reviewAgent` on GitLab (#4326): refused by name. A merge request pipeline
 * hands every job the project's unprotected variables, so a review job there
 * cannot be kept apart from a token that writes.
 */

import { describe, expect, test } from "vitest";
import { generateGitlabOpPipeline } from "./generate-op-pipeline";

describe("generateGitlabOpPipeline: reviewAgent", () => {
  test("is refused, naming the Op and the way out", () => {
    expect(() => generateGitlabOpPipeline([{ name: "pr-review", trigger: { kind: "pull_request" }, reviewAgent: true }])).toThrow(
      /Scheduled Op "pr-review" sets reviewAgent.*unprotected variables.*findingMode "comment".*GitHub or Forgejo/s,
    );
  });

  test("an Op without it generates as before", () => {
    const out = generateGitlabOpPipeline([{ name: "pr-review", trigger: { kind: "pull_request" }, findingMode: "comment" }]);
    expect(out.jobs.map((j) => j.jobName)).toEqual(["pr-review"]);
  });
});
