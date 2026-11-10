/**
 * The product plan's locks on what a change reaches (#4979): one lock job
 * that runs the product's reach line at the target branch's commit, on
 * GitHub, Forgejo and GitLab, and GitLab's comment lock and unlock jobs.
 */
import { describe, expect, test } from "vitest";
import { generateProductPlanPipeline } from "./product-plan-pipeline";
import { generateForgejoProductPlanPipeline } from "../../../forgejo/src/components/product-plan-pipeline";
import { generateGitlabProductPlanPipeline } from "../../../gitlab/src/components/product-plan-pipeline";

const words = {
  product: "terragucci",
  noun: ["root", "roots"] as [string, string],
  commands: { plan: "plan" as const, lock: "lock" as const, unlock: "unlock" as const },
  approval: "per-wave" as const,
  op: "tf-apply",
  bin: "npx --no-install terragucci",
};

const reach = { command: 'terragucci reached --layers "envs/dev,envs/prod"', gate: "tf-apply" };
const base = {
  words,
  beforeScript: ["npm ci"],
  locks: "plan" as const,
  productPlan: { command: "terragucci plan --out {output}", workflow: "terragucci-pr", reach },
};

type Job = { if?: string; needs?: string[]; permissions?: Record<string, string>; steps: Array<{ name?: string; env?: Record<string, string>; run?: string; uses?: string; with?: Record<string, unknown> }> };
type GitlabJob = { stage: string; rules: Array<{ if: string }>; variables?: Record<string, string>; script: string[]; resource_group?: string };

describe("the reach lock job on GitHub and Forgejo (#4979)", () => {
  test("locks what the change reaches, beside the plan, at the target branch's commit, for a pull request of this repository", () => {
    const { doc, jobs } = generateProductPlanPipeline("default", base);
    const lock = doc.jobsDoc.lock as Job;
    expect(lock.needs).toBeUndefined();
    expect(lock.if).toBe("github.event_name == 'pull_request' && github.event.action != 'closed' && github.event.pull_request.head.repo.full_name == github.repository");
    expect(lock.permissions).toEqual({ contents: "write", "pull-requests": "read", statuses: "write" });
    expect(lock.steps[0]!.with).toEqual({ ref: "${{ github.event.pull_request.base.sha }}", "fetch-depth": 0 });
    expect(lock.steps[1]!.run).toBe("npm ci");
    const take = lock.steps[2]!;
    expect(take.run).toBe('npx --no-install terragucci lock --reach --pr "$PR_NUMBER" --head "$HEAD_SHA" --base "$BASE_SHA" --stage plan --gate tf-apply --forge github');
    // The line is the step's variable, never shell text.
    expect(take.env).toEqual({
      PR_NUMBER: "${{ github.event.pull_request.number }}",
      HEAD_SHA: "${{ github.event.pull_request.head.sha }}",
      BASE_SHA: "${{ github.event.pull_request.base.sha }}",
      GITHUB_TOKEN: "${{ github.token }}",
      CHANT_LOCK_REACH: reach.command,
    });
    // No lock job reads a PrReport, and the close still releases.
    expect(Object.keys(doc.jobsDoc).filter((k) => k.startsWith("lock"))).toEqual(["lock"]);
    expect((doc.jobsDoc.unlock as Job).if).toBe("github.event_name == 'pull_request' && github.event.action == 'closed'");
    expect(jobs.reachLock?.jobName).toBe("lock");
  });

  test("with targets it is still one job, for the one reach line", () => {
    const { doc } = generateProductPlanPipeline("default", { ...base, productPlan: { ...base.productPlan, targets: [{ name: "staging" }, { name: "prod" }] } });
    expect(Object.keys(doc.jobsDoc).filter((k) => k.startsWith("lock"))).toEqual(["lock"]);
  });

  test("Forgejo runs the same line with its own forge", () => {
    const { doc } = generateForgejoProductPlanPipeline("default", base);
    const lock = doc.jobsDoc.lock as Job;
    expect(lock.steps[lock.steps.length - 1]!.run).toBe('npx --no-install terragucci lock --reach --pr "$PR_NUMBER" --head "$HEAD_SHA" --base "$BASE_SHA" --stage plan --gate tf-apply --forge forgejo');
  });

  test("reach is refused without locks, empty, over two lines or with a gate that is not a file name", () => {
    expect(() => generateProductPlanPipeline("default", { ...base, locks: undefined, words: { ...words, commands: { plan: "plan" as const } } })).toThrow(/reach says what the lock job locks/);
    expect(() => generateProductPlanPipeline("default", { ...base, productPlan: { ...base.productPlan, reach: { command: " " } } })).toThrow(/reach\.command is empty/);
    expect(() => generateProductPlanPipeline("default", { ...base, productPlan: { ...base.productPlan, reach: { command: "a\nb" } } })).toThrow(/one shell line/);
    expect(() => generateProductPlanPipeline("default", { ...base, productPlan: { ...base.productPlan, reach: { command: "x", gate: "../x" } } })).toThrow(/not a lock file name/);
  });

  test("without reach the lock jobs read the plan's PrReport, as before", () => {
    const { doc, jobs } = generateProductPlanPipeline("default", { ...base, productPlan: { command: base.productPlan.command, workflow: "terragucci-pr" } });
    expect((doc.jobsDoc.lock as Job).needs).toEqual(["plan"]);
    expect(jobs.reachLock).toBeUndefined();
  });
});

describe("the reach lock job on GitLab (#4979)", () => {
  test("runs in the plan notes pipeline and locks every open merge request into the branch", () => {
    const { entries, jobs } = generateGitlabProductPlanPipeline("default", base);
    const doc = Object.fromEntries(entries) as Record<string, unknown>;
    const lock = doc.lock as GitlabJob;
    expect(lock.stage).toBe("lock");
    expect(lock.rules).toEqual([{ if: '$CI_PIPELINE_SOURCE =~ /^(schedule|web|api|trigger)$/ && $CHANT_PLAN_NOTES == "1" && $CI_COMMIT_BRANCH == $CI_DEFAULT_BRANCH' }]);
    expect(lock.resource_group).toBe("lock");
    expect(lock.variables).toEqual({ CHANT_LOCK_REACH: reach.command });
    expect(lock.script).toEqual(["npm ci", 'npx --no-install terragucci lock --reach --open --base "$CI_COMMIT_SHA" --stage plan --gate tf-apply --forge gitlab']);
    expect((doc.stages as string[]).slice(0, 3)).toEqual(["plan", "plan-note", "lock"]);
    expect(jobs.reachLock?.command).toContain("--open");
  });

  test("with noteCommands the comment lock and unlock jobs run in a pipeline of the target branch each starts", () => {
    const { entries } = generateGitlabProductPlanPipeline("default", { ...base, noteCommands: true, productPlan: { ...base.productPlan, replan: true } });
    const doc = Object.fromEntries(entries) as Record<string, unknown>;
    const lock = doc["comment-lock"] as GitlabJob;
    expect(lock.rules).toEqual([{ if: "$CI_PIPELINE_SOURCE =~ /^(web|api|trigger)$/ && $CHANT_LOCK_PR =~ /^[0-9]+$/ && $CI_COMMIT_BRANCH == $CI_DEFAULT_BRANCH" }]);
    expect(lock.script[lock.script.length - 1]).toBe('npx --no-install terragucci lock --keep --pr "$PR_NUMBER" --forge gitlab');
    expect((doc["comment-unlock"] as GitlabJob).variables).toEqual({ PR_NUMBER: "$CHANT_UNLOCK_PR" });
    const workflow = doc.workflow as { rules: Array<{ if: string }> };
    expect(workflow.rules.map((r) => r.if)).toContain(lock.rules[0]!.if);
    // The note poll starts them.
    expect(doc["note-commands"]).toMatchObject({ script: ["npm ci", expect.stringContaining("--locks")] });
  });

  test("GitLab's locks need reach, as no lock job there reads a PrReport", () => {
    expect(() => generateGitlabProductPlanPipeline("default", { ...base, productPlan: { command: base.productPlan.command } })).toThrow(/takes locks on GitLab only with reach/);
  });
});
