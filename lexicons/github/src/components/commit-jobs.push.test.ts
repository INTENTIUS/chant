/** #4749: a commit job after a check that runs on push, and a push with the job's own token. */
import { describe, expect, test } from "vitest";
import { resolveCommitSpec, type OpCommitSpec } from "@intentius/chant/ci-commit";
import type { ScheduledOpSpec } from "@intentius/chant/lexicon";
import { githubCommitJobs } from "./commit-jobs";
import { generateGithubOpPipeline } from "./generate-op-pipeline";

type Step = { name?: string; run?: string; env?: Record<string, string> };
const settings = (extra: Partial<OpCommitSpec> = {}) => resolveCommitSpec("tf-fmt", { on: "check", command: ["terragucci", "fmt", "--write"], allowed: ["infra/"], ...extra }, "terragucci");
const jobs = (extra: Partial<OpCommitSpec>, input: { tokenEnv?: string; onPush?: boolean } = {}) =>
  githubCommitJobs({ forge: "github", jobName: "check-commit", image: "node:22", settings: settings(extra), setup: [], beforeScript: [], after: "check", ...input });

describe("commit jobs after a check on push (#4749)", () => {
  test("fetch the pushed commit as the head, with no pull request number from the event", () => {
    const { commit, push } = jobs({}, { tokenEnv: "TG_PUSH", onPush: true });
    for (const job of [commit, push]) {
      const checkout = (job.steps as Step[])[0]!;
      expect(checkout.env).toMatchObject({ PUSHED_SHA: "${{ github.sha }}" });
      expect(checkout.env).not.toHaveProperty("PR_NUMBER");
      expect(checkout.run).toContain('fetch -q --no-tags origin "+$PUSHED_SHA:refs/chant/commit-head"');
    }
    expect(commit.if).toBe("always() && needs.check.outputs.finding == 'true'");
  });

  test("without onPush the pull request's head is fetched, as before", () => {
    const checkout = (jobs({}, { tokenEnv: "TG_PUSH" }).commit.steps as Step[])[0]!;
    expect(checkout.env).toMatchObject({ PR_NUMBER: "${{ github.event.pull_request.number }}" });
  });
});

describe("a push with the job's own token (#4749)", () => {
  test("jobToken pushes with github.token, and after runs only once a commit was pushed", () => {
    const { push } = jobs({ jobToken: true, after: ["terragucci lock --plan --head \"$CHANT_COMMIT_SHA\""] }, { onPush: true });
    const steps = push.steps as Step[];
    const land = steps.find((s) => s.name === "Push the change to the pull request")!;
    expect(land.env).toMatchObject({ CHANT_COMMIT_TOKEN: "${{ github.token }}", GITHUB_TOKEN: "${{ github.token }}" });
    const after = steps.at(-1)!;
    expect(after.name).toBe("After the push");
    expect(after.run).toBe(['if [ -s .chant/commit/pushed ]; then', '  export CHANT_COMMIT_SHA="$(cat .chant/commit/pushed)"', '  terragucci lock --plan --head "$CHANT_COMMIT_SHA"', "fi"].join("\n"));
  });

  test("no token and no jobToken is refused; jobToken with tokenEnv is refused", () => {
    expect(() => jobs({})).toThrow(/name tokenEnv, or set jobToken/);
    expect(() => settings({ jobToken: true, tokenEnv: "TG_PUSH" })).toThrow(/leave tokenEnv out/);
    expect(() => settings({ after: ["a\nb"] })).toThrow(/one command each/);
  });

  test("the Op generator takes jobToken in place of tokenEnv, and still refuses neither", () => {
    const spec = (commit: Partial<OpCommitSpec>): ScheduledOpSpec => ({ name: "chant-fmt", commit: { on: "comment", comment: "/chant fmt", command: ["tofu", "fmt"], allowed: ["infra/"], ...commit } });
    const yaml = generateGithubOpPipeline([spec({ jobToken: true, after: ["echo pushed"] })]).files[0]!.yaml;
    expect(yaml).toMatch(/CHANT_COMMIT_TOKEN: '\$\{\{ github\.token \}\}'/);
    expect(yaml).toContain("echo pushed");
    expect(() => generateGithubOpPipeline([spec({})])).toThrow(/no tokenEnv/);
  });
});
