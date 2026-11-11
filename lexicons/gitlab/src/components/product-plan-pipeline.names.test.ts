/**
 * #5003: the product plan keeps a product's own names, on GitLab. The
 * defaults render as they did before the options (the `default` goldens
 * were written from main before #5003), and a plan given a pipeline file,
 * job names, a status context and a report directory renders those names
 * (the `names` goldens): here terragucci's, as its own pipeline has them.
 */
import { describe, expect, test } from "vitest";
import { generateGitlabProductPlanPipeline } from "./product-plan-pipeline";

const words = {
  product: "terragucci",
  noun: ["root", "roots"] as [string, string],
  commands: { plan: "plan" as const, lock: "lock" as const, unlock: "unlock" as const },
  approve: "terragucci approve {gate} --plan {digest} {sign}",
  op: "tf-apply",
  gateName: "wave-{k}",
  approval: "per-wave" as const,
  bin: "terragucci chant",
};

const reach = { command: 'terragucci reached --base "$BASE_SHA" --head "$HEAD_SHA"' };

const base = {
  words,
  beforeScript: ["npm ci"],
  locks: "plan" as const,
  noteCommands: true,
  evidence: { runnerKeySecret: "CHANT_RUNNER_KEY_PEM" },
  productPlan: {
    command: "terragucci plan --pr-note {output}",
    forks: "skip" as const,
    record: true,
    reach,
    replan: { notAffected: true },
  },
};

const targets = {
  words: { ...words, product: "yodel", bin: "yodel chant", commands: { plan: "plan" as const } },
  noteCommands: true,
  evidence: { runnerKeySecret: "CHANT_RUNNER_KEY_PEM" },
  productPlan: {
    command: "yodel plan {target} --pr-note {output}",
    targets: [{ name: "staging" }, { name: "prod" }],
    replan: true,
  },
};

/** terragucci's names, as its own `.gitlab/terragucci.yml` has them. */
const terragucci = {
  ...base,
  productPlan: {
    ...base.productPlan,
    workflow: "terragucci",
    workflowFile: ".gitlab/terragucci.yml",
    jobNames: { plan: "plan", note: "plan-note", replan: "replan", replanNote: "replan-note" },
    statusContext: "terragucci/plan",
    artifact: "terragucci-report",
    reportDir: "terragucci-report",
  },
};

/** Names of a product's own for each target. */
const named = {
  ...targets,
  productPlan: {
    ...targets.productPlan,
    workflow: "yodel-pr",
    workflowFile: ".gitlab/yodel-plan.gitlab-ci.yml",
    jobNames: { plan: "yodel-plan-{target}", note: "yodel-note-{target}", replan: "yodel-replan-{target}", replanNote: "yodel-replan-note-{target}" },
    statusContext: "yodel/{target}/plan",
    artifact: "yodel-report",
    reportDir: "out/yodel",
  },
};

type Job = { needs?: Array<{ job: string }>; script: string[]; artifacts?: { name: string; paths: string[] } };

describe("the product plan's names on GitLab (#5003)", () => {
  test("the defaults render as before", async () => {
    await expect(generateGitlabProductPlanPipeline("default", base).yaml).toMatchFileSnapshot("./__golden__/product-plan-default.gitlab.yml");
    await expect(generateGitlabProductPlanPipeline("default", targets).yaml).toMatchFileSnapshot("./__golden__/product-plan-default-targets.gitlab.yml");
    expect(generateGitlabProductPlanPipeline("default", base).path).toBe(".gitlab/chant-pr-default.gitlab-ci.yml");
  });

  test("terragucci's names: its pipeline file, jobs, terragucci/plan and terragucci-report/", async () => {
    const { yaml, entries, path } = generateGitlabProductPlanPipeline("default", terragucci);
    await expect(yaml).toMatchFileSnapshot("./__golden__/product-plan-names.gitlab.yml");
    expect(path).toBe(".gitlab/terragucci.yml");
    const job = (name: string) => entries.find(([k]) => k === name)![1] as Job;
    expect((entries[0]![1] as { name: string }).name).toBe("terragucci");
    expect(job("plan").artifacts).toMatchObject({ name: "terragucci-report", paths: ["terragucci-report"] });
    expect(job("replan").artifacts).toMatchObject({ name: "terragucci-report-replan", paths: ["terragucci-report"] });
    // The plan job keeps chant's name, so pr-post --open finds it without --plan-job.
    expect(job("plan-note").script.at(-1)).toContain("pr-post --open --env default --output terragucci-report --forge gitlab --context terragucci/plan --record-run plan");
    expect(job("plan-note").script.at(-1)).not.toContain("--plan-job");
    expect(job("replan-note").script.at(-1)).toContain("--output terragucci-report --forge gitlab --context terragucci/plan");
    expect(yaml).not.toContain(".chant/pr");
  });

  test("names of the product's own for each target; pr-post --open looks for the plan job by its name", async () => {
    const { yaml, entries, path } = generateGitlabProductPlanPipeline("default", named);
    await expect(yaml).toMatchFileSnapshot("./__golden__/product-plan-names-targets.gitlab.yml");
    expect(path).toBe(".gitlab/yodel-plan.gitlab-ci.yml");
    const keys = entries.map(([k]) => k);
    for (const k of ["yodel-plan-staging", "yodel-plan-prod", "yodel-plan-staging-evidence", "yodel-note-staging", "yodel-note-prod", "yodel-replan-prod", "yodel-replan-note-prod"]) expect(keys).toContain(k);
    const job = (name: string) => entries.find(([k]) => k === name)![1] as Job;
    expect(job("yodel-note-prod").script.at(-1)).toContain("--output out/yodel --forge gitlab --member prod --context yodel/prod/plan --plan-job yodel-plan-prod");
    expect(job("yodel-plan-prod").artifacts).toMatchObject({ name: "yodel-report-prod", paths: ["out/yodel"] });
    expect(job("yodel-replan-note-prod").needs).toEqual([{ job: "yodel-replan-prod", artifacts: true }]);
    expect(job("yodel-replan-note-prod").script.at(-1)).toContain("--output out/yodel --forge gitlab --member prod --context yodel/prod/plan");
    expect(job("yodel-replan-note-prod").script.at(-1)).not.toContain("--plan-job");
    expect(yaml).not.toContain(".chant/pr");
  });

  test("refuses a job name GitLab keeps for itself", () => {
    expect(() => generateGitlabProductPlanPipeline("default", { ...terragucci, productPlan: { ...terragucci.productPlan, jobNames: { plan: "stages" } } })).toThrow(/no GitLab keyword/);
  });
});
