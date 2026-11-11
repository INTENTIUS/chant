/**
 * #5004: GitLab's product plan job keeps the product's own artifacts beside
 * the report directory, as the check job does (#4988): `artifacts: { paths,
 * reports }`, such as terragucci's terraform report for the merge request's
 * widget. The re-plan jobs keep the report directory alone. GitHub and
 * Forgejo refuse the option (the forgejo lexicon's
 * `product-plan-pipeline.reports.test.ts`), so their renders do not change.
 */
import { describe, expect, test } from "vitest";
import { generateGitlabProductPlanPipeline } from "./product-plan-pipeline";

const words = {
  product: "terragucci",
  noun: ["root", "roots"] as [string, string],
  commands: { plan: "plan" as const },
  approval: "per-wave" as const,
  op: "tf-apply",
  bin: "terragucci chant",
};

/** terragucci's plan job, with its names (#5003) and its terraform report. */
const terragucci = {
  words,
  noteCommands: true,
  productPlan: {
    command: "terragucci plan --pr-note {output}",
    workflow: "terragucci",
    workflowFile: ".gitlab/terragucci.yml",
    artifact: "terragucci-report",
    reportDir: "terragucci-report",
    replan: true,
    artifacts: { reports: { terraform: "{output}/gitlab-terraform.json" } },
  },
};

type Job = { artifacts: { name: string; when: string; paths: string[]; reports?: Record<string, unknown> } };

describe("the product plan job's artifacts on GitLab (#5004)", () => {
  test("the plan job keeps the terraform report under artifacts:reports", async () => {
    const { yaml, entries } = generateGitlabProductPlanPipeline("default", terragucci);
    await expect(yaml).toMatchFileSnapshot("./__golden__/product-plan-reports.gitlab.yml");
    const job = (name: string) => entries.find(([k]) => k === name)![1] as Job;
    // terragucci's own plan job today: name, when, paths, then reports.
    expect(job("plan").artifacts).toEqual({ name: "terragucci-report", when: "always", paths: ["terragucci-report"], reports: { terraform: "terragucci-report/gitlab-terraform.json" } });
    expect(Object.keys(job("plan").artifacts)).toEqual(["name", "when", "paths", "reports"]);
    // The re-plan runs in the target branch's pipeline, whose reports GitLab reads as the branch's own.
    expect(job("replan").artifacts).toEqual({ name: "terragucci-report-replan", when: "always", paths: ["terragucci-report"] });
  });

  test("each target's plan job gets its own paths and reports, {target} filled", () => {
    const { entries } = generateGitlabProductPlanPipeline("default", {
      words,
      productPlan: {
        command: "yodel plan {target} --pr-note {output}",
        targets: [{ name: "staging" }, { name: "prod" }],
        artifacts: { paths: ["out/{target}/"], reports: { codequality: ["out/{target}/quality.json", "{output}/lint.json"] } },
      },
    });
    const job = (name: string) => entries.find(([k]) => k === name)![1] as Job;
    expect(job("prod-plan").artifacts).toEqual({ name: "chant-pr-plan-prod", when: "always", paths: [".chant/pr", "out/prod/"], reports: { codequality: ["out/prod/quality.json", ".chant/pr/lint.json"] } });
    expect(job("staging-plan").artifacts.paths).toEqual([".chant/pr", "out/staging/"]);
  });

  test("empty artifacts render as none", () => {
    const { productPlan: { artifacts: _a, ...plan }, ...rest } = terragucci;
    const without = generateGitlabProductPlanPipeline("default", { ...rest, productPlan: plan }).yaml;
    expect(generateGitlabProductPlanPipeline("default", { ...rest, productPlan: { ...plan, artifacts: {} } }).yaml).toBe(without);
    expect(generateGitlabProductPlanPipeline("default", { ...rest, productPlan: { ...plan, artifacts: { paths: [], reports: {} } } }).yaml).toBe(without);
    expect(without).not.toContain("reports:");
  });

  test("refuses a path outside the checkout, a report type that is not one, and coverage_report", () => {
    const at = (artifacts: Record<string, unknown>) => () => generateGitlabProductPlanPipeline("default", { ...terragucci, productPlan: { ...terragucci.productPlan, artifacts } });
    expect(at({ paths: ["../x"] })).toThrow('the product plan\'s artifact path "../x" is not a relative path inside the checkout');
    expect(at({ reports: { "Terraform": "a.json" } })).toThrow(/is not a GitLab report type/);
    expect(at({ reports: { coverage_report: "c.xml" } })).toThrow(/coverage_report takes a format besides/);
    expect(at({ reports: { terraform: [] } })).toThrow(/terraform report \[\] is not a relative path/);
  });
});
