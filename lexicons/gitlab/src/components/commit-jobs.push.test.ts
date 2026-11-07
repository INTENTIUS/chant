/** #4749: a GitLab commit job after a check in a branch pipeline. */
import { describe, expect, test } from "vitest";
import { resolveCommitSpec, type OpCommitSpec } from "@intentius/chant/ci-commit";
import { gitlabCommitJobs } from "./commit-jobs";

const settings = (extra: Partial<OpCommitSpec> = {}) => resolveCommitSpec("tf-fmt", { on: "check", command: ["terragucci", "fmt", "--write"], allowed: ["infra/"], ...extra }, "terragucci");
const jobs = (extra: Partial<OpCommitSpec>, onPush?: boolean) =>
  gitlabCommitJobs({ jobName: "check-commit", stage: "check", image: "node:22", settings: settings(extra), script: [], after: { job: "check", rules: [{ if: "$CI_COMMIT_BRANCH" }] }, ...(onPush ? { onPush } : {}) });

describe("GitLab commit jobs after a check in a branch pipeline (#4749)", () => {
  test("fetch CI_COMMIT_SHA as the head in both jobs, and run after in one script entry", () => {
    const { commit, push } = jobs({ after: ["terragucci lock --head \"$CHANT_COMMIT_SHA\""] }, true);
    for (const job of [commit, push]) {
      const script = (job.script as string[]).join("\n");
      expect(script).toContain('"+$CI_COMMIT_SHA:refs/chant/commit-head"');
      expect(script).not.toContain("CI_MERGE_REQUEST_IID");
    }
    const last = (push.script as string[]).at(-1)!;
    expect(last.split("\n")[0]).toBe("if [ -s .chant/commit/pushed ]; then");
    expect(last).toContain('terragucci lock --head "$CHANT_COMMIT_SHA"');
  });

  test("a merge request pipeline still reads the merge request, and jobToken is refused", () => {
    expect((jobs({}).commit.script as string[]).join("\n")).toContain("CI_MERGE_REQUEST_IID");
    expect(() => jobs({ jobToken: true })).toThrow(/GitLab's job token cannot/);
  });
});
