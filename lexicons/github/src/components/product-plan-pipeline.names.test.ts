/**
 * #5003: the product plan keeps a product's own names. The defaults render
 * as they did before the options (the `default` goldens were written from
 * main before #5003), and a plan given a workflow file, job names, a status
 * context and a report directory renders those names (the `names` goldens):
 * here terragucci's, as its own workflow has them.
 */
import { describe, expect, test } from "vitest";
import { generateProductPlanPipeline } from "./product-plan-pipeline";

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
  evidence: { runnerKeySecret: "CHANT_RUNNER_KEY_PEM" },
  productPlan: {
    command: "terragucci plan --pr-note {output}",
    forks: "skip" as const,
    pending: true,
    record: true,
    reach,
    replan: { dispatch: { argument: "root" }, reply: true, notAffected: true },
  },
};

const targets = {
  words: { ...words, product: "yodel", bin: "yodel chant", commands: { plan: "plan" as const } },
  evidence: { runnerKeySecret: "CHANT_RUNNER_KEY_PEM" },
  productPlan: {
    command: "yodel plan {target} --pr-note {output}",
    targets: [{ name: "staging" }, { name: "prod" }],
    pending: true,
    replan: true,
  },
};

/** terragucci's names, as its own `.github/workflows/terragucci.yml` has them. */
const terragucci = {
  ...base,
  productPlan: {
    ...base.productPlan,
    workflow: "terragucci",
    workflowFile: ".github/workflows/terragucci.yml",
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
    workflowFile: ".github/workflows/yodel-pr.yml",
    jobNames: { plan: "yodel-plan-{target}", note: "yodel-note-{target}", replan: "yodel-replan-{target}", replanNote: "yodel-replan-note-{target}" },
    statusContext: "yodel/{target}/plan",
    artifact: "yodel-report",
    reportDir: "out/yodel",
  },
};

type Job = { needs?: string[]; steps: Array<{ name?: string; id?: string; env?: Record<string, string>; run?: string; with?: Record<string, unknown> }> };

describe("the product plan's names on GitHub (#5003)", () => {
  test("the defaults render as before", async () => {
    await expect(generateProductPlanPipeline("default", base).yaml).toMatchFileSnapshot("./__golden__/product-plan-default.github.yml");
    await expect(generateProductPlanPipeline("default", targets).yaml).toMatchFileSnapshot("./__golden__/product-plan-default-targets.github.yml");
    expect(generateProductPlanPipeline("default", base).path).toBe(".github/workflows/chant-pr-default.yml");
  });

  test("terragucci's names: its workflow, jobs, terragucci/plan and terragucci-report/", async () => {
    const { yaml, doc, path } = generateProductPlanPipeline("default", terragucci);
    await expect(yaml).toMatchFileSnapshot("./__golden__/product-plan-names.github.yml");
    expect(path).toBe(".github/workflows/terragucci.yml");
    expect(doc.name).toBe("terragucci");
    expect(Object.keys(doc.jobsDoc).slice(0, 4)).toEqual(["plan", "plan-note", "replan", "replan-note"]);
    const note = doc.jobsDoc["plan-note"] as Job;
    expect(note.steps.find((s) => s.name === "Keep the plan report")!.with).toMatchObject({ name: "terragucci-report", path: "terragucci-report" });
    expect(note.steps.at(-1)!.name).toBe("Post the plan note and terragucci/plan");
    expect(note.steps.at(-1)!.run).toContain("--output terragucci-report --forge github --result \"$PLAN_RESULT\" --context terragucci/plan --record-run plan");
    const plan = doc.jobsDoc.plan as Job;
    expect(plan.steps.find((s) => s.id === "plan")!.run).toContain("terragucci plan --pr-note terragucci-report");
    expect(plan.steps.find((s) => s.id === "plan")!.run).toContain('chant_report="$PWD/terragucci-report"');
    expect((doc.jobsDoc["replan-note"] as Job).steps.find((s) => s.name === "Keep the plan report")!.with).toMatchObject({ name: "terragucci-report-replan", path: "terragucci-report" });
    expect(yaml).not.toContain(".chant/pr");
  });

  test("names of the product's own for each target", async () => {
    const { yaml, doc, path, jobs } = generateProductPlanPipeline("default", named);
    await expect(yaml).toMatchFileSnapshot("./__golden__/product-plan-names-targets.github.yml");
    expect(path).toBe(".github/workflows/yodel-pr.yml");
    expect(Object.keys(doc.jobsDoc)).toEqual(["yodel-plan-staging", "yodel-note-staging", "yodel-plan-prod", "yodel-note-prod", "yodel-replan-staging", "yodel-replan-note-staging", "yodel-replan-prod", "yodel-replan-note-prod"]);
    const note = doc.jobsDoc["yodel-note-prod"] as Job;
    expect(note.needs).toEqual(["yodel-plan-prod"]);
    expect(note.steps.at(-1)!.env!.PLAN_RESULT).toBe("${{ needs.yodel-plan-prod.result }}");
    expect(note.steps.at(-1)!.run).toContain("--output out/yodel --forge github --member prod --result \"$PLAN_RESULT\" --context yodel/prod/plan");
    expect((doc.jobsDoc["yodel-plan-prod"] as Job).steps[0]!.env!.CHANT_PENDING_CONTEXT).toBe("yodel/prod/plan");
    expect((doc.jobsDoc["yodel-replan-note-prod"] as Job).needs).toEqual(["yodel-replan-prod"]);
    expect((doc.jobsDoc["yodel-replan-note-prod"] as Job).steps.at(-1)!.run).toContain("--context yodel/prod/plan");
    expect(jobs.productPlan!.map((p) => [p.jobName, p.context, p.reportDir])).toEqual([["yodel-plan-staging", "yodel/staging/plan", "out/yodel"], ["yodel-plan-prod", "yodel/prod/plan", "out/yodel"]]);
    expect(yaml).not.toContain(".chant/pr");
  });

  test("refuses names that are not one, or that two jobs share", () => {
    const plan = (p: Record<string, unknown>) => () => generateProductPlanPipeline("default", { ...named, productPlan: { ...named.productPlan, ...p } });
    expect(plan({ workflowFile: ".github/workflows/sub/yodel.yml" })).toThrow(/directly under \.github\/workflows\//);
    expect(plan({ workflowFile: ".forgejo/workflows/yodel.yml" })).toThrow(/directly under \.github\/workflows\//);
    expect(plan({ workflowFile: ".github/workflows/yodel.json" })).toThrow(/not a \.yml or \.yaml file/);
    expect(plan({ jobNames: { plan: "plan" } })).toThrow(/jobNames\.plan "plan" names every target's job, so it holds \{target\}/);
    expect(plan({ jobNames: { plan: "{target}", note: "{target}" } })).toThrow(/names two jobs staging/);
    expect(plan({ jobNames: { plan: "1-{target}" } })).toThrow(/not a job name/);
    expect(plan({ statusContext: "yodel/plan" })).toThrow(/holds \{target\}/);
    expect(plan({ statusContext: "yodel plan/{target}" })).toThrow(/not a status context/);
    expect(plan({ reportDir: "../out" })).toThrow(/reportDir "\.\.\/out" is not a directory/);
    expect(plan({ reportDir: "/tmp/out" })).toThrow(/reportDir/);
    expect(plan({ reportDir: "out/" })).toThrow(/reportDir/);
    expect(() => generateProductPlanPipeline("default", { ...terragucci, productPlan: { ...terragucci.productPlan, jobNames: { plan: "plan-{target}" } } })).toThrow(/holds \{target\}, and the plan has no targets/);
  });
});
