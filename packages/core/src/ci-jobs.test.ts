import { describe, expect, test } from "vitest";
import {
  assertGitlabBranch,
  CI_IMAGE,
  gitlabRules,
  githubSecret,
  githubSecretEnv,
  githubSecretOrJobToken,
  pushBranches,
  triggerBranches,
} from "./ci-jobs";
import { PR_LOOP_IMAGE } from "./components/pr-pipeline";

describe("the job primitives the CI generators share (#3765)", () => {
  test("one default image, which the pull-request pipeline uses too", () => {
    expect(CI_IMAGE).toBe("node:22");
    expect(PR_LOOP_IMAGE).toBe(CI_IMAGE);
  });

  test("a push trigger with no branches, or an empty list, filters on main; a pull_request trigger then takes every branch", () => {
    expect(pushBranches(undefined)).toEqual(["main"]);
    expect(pushBranches([])).toEqual(["main"]);
    expect(pushBranches(["trunk"])).toEqual(["trunk"]);
    expect(triggerBranches({ kind: "push", branches: [] })).toEqual(["main"]);
    expect(triggerBranches({ kind: "pull_request", branches: [] })).toBeUndefined();
    expect(triggerBranches({ kind: "pull_request", branches: ["main"] })).toEqual(["main"]);
    expect(triggerBranches({ kind: "cron", schedule: "0 * * * *" })).toBeUndefined();
  });

  test("a secret, and a secret that falls back to the job token when unset (#3624)", () => {
    expect(githubSecret("T")).toBe("${{ secrets.T }}");
    expect(githubSecretOrJobToken("T")).toBe("${{ secrets.T || github.token }}");
    expect(githubSecretEnv(["A", "B"])).toEqual({ A: "${{ secrets.A }}", B: "${{ secrets.B }}" });
  });

  test("GitLab rules: one entry per branch, and a branch that would break the expression is refused", () => {
    const selector = { variable: "CHANT_SCHEDULED_OP", value: "watch" };
    expect(gitlabRules("Scheduled Op \"apply\"", { kind: "push", branches: ["main", "prod"] }, selector)).toEqual([
      { if: '$CI_PIPELINE_SOURCE == "push" && $CI_COMMIT_BRANCH == "main"' },
      { if: '$CI_PIPELINE_SOURCE == "push" && $CI_COMMIT_BRANCH == "prod"' },
    ]);
    expect(gitlabRules("x", { kind: "pull_request", branches: [] }, selector)).toEqual([{ if: '$CI_PIPELINE_SOURCE == "merge_request_event"' }]);
    expect(gitlabRules("x", { kind: "cron", schedule: "0 * * * *" }, selector)).toEqual([
      { if: '$CI_PIPELINE_SOURCE == "schedule" && $CHANT_SCHEDULED_OP == "watch"' },
    ]);
    expect(() => assertGitlabBranch("Op waves \"w\"", "a$b")).toThrow(/Op waves "w" filters on branch "a\$b"/);
    expect(() => assertGitlabBranch("Op waves \"w\"", " ")).toThrow(/empty branch filter/);
  });
});
