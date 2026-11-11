/**
 * #5003: the product plan keeps a product's own names, on Forgejo. The
 * defaults render as they did before the options (the `default` goldens
 * were written from main before #5003), and a plan given a workflow file,
 * job names, a status context and a report directory renders those names
 * (the `names` goldens): here terragucci's, as its own workflow has them.
 */
import { describe, expect, test } from "vitest";
import { generateForgejoProductPlanPipeline } from "./product-plan-pipeline";

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

/** terragucci's names, as its own `.forgejo/workflows/terragucci.yml` has them. */
const terragucci = {
  ...base,
  productPlan: {
    ...base.productPlan,
    workflow: "terragucci",
    workflowFile: ".forgejo/workflows/terragucci.yml",
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
    workflowFile: ".forgejo/workflows/yodel-pr.yml",
    jobNames: { plan: "yodel-plan-{target}", note: "yodel-note-{target}", replan: "yodel-replan-{target}", replanNote: "yodel-replan-note-{target}" },
    statusContext: "yodel/{target}/plan",
    artifact: "yodel-report",
    reportDir: "out/yodel",
  },
};

type Job = { needs?: string[]; steps: Array<{ name?: string; run?: string; with?: Record<string, unknown> }> };

describe("the product plan's names on Forgejo (#5003)", () => {
  test("the defaults render as before", async () => {
    await expect(generateForgejoProductPlanPipeline("default", base).yaml).toMatchFileSnapshot("./__golden__/product-plan-default.forgejo.yml");
    await expect(generateForgejoProductPlanPipeline("default", targets).yaml).toMatchFileSnapshot("./__golden__/product-plan-default-targets.forgejo.yml");
    expect(generateForgejoProductPlanPipeline("default", base).path).toBe(".forgejo/workflows/chant-pr-default.yml");
  });

  test("terragucci's names: its workflow, jobs, terragucci/plan and terragucci-report/", async () => {
    const { yaml, doc, path } = generateForgejoProductPlanPipeline("default", terragucci);
    await expect(yaml).toMatchFileSnapshot("./__golden__/product-plan-names.forgejo.yml");
    expect(path).toBe(".forgejo/workflows/terragucci.yml");
    expect(doc.name).toBe("terragucci");
    const note = doc.jobsDoc["plan-note"] as Job;
    expect(note.steps.find((s) => s.name === "Keep the plan report")!.with).toMatchObject({ name: "terragucci-report", path: "terragucci-report" });
    expect(note.steps.at(-1)!.run).toContain("--output terragucci-report --forge forgejo --result \"$PLAN_RESULT\" --context terragucci/plan");
    expect(yaml).not.toContain(".chant/pr");
  });

  test("names of the product's own for each target", async () => {
    const { yaml, doc, path } = generateForgejoProductPlanPipeline("default", named);
    await expect(yaml).toMatchFileSnapshot("./__golden__/product-plan-names-targets.forgejo.yml");
    expect(path).toBe(".forgejo/workflows/yodel-pr.yml");
    expect(Object.keys(doc.jobsDoc)).toEqual(["yodel-plan-staging", "yodel-note-staging", "yodel-plan-prod", "yodel-note-prod", "yodel-replan-staging", "yodel-replan-note-staging", "yodel-replan-prod", "yodel-replan-note-prod"]);
    expect((doc.jobsDoc["yodel-note-prod"] as Job).steps.at(-1)!.run).toContain("--forge forgejo --member prod --result \"$PLAN_RESULT\" --context yodel/prod/plan");
    expect(() => generateForgejoProductPlanPipeline("default", { ...named, productPlan: { ...named.productPlan, workflowFile: ".github/workflows/yodel-pr.yml" } })).toThrow(/directly under \.forgejo\/workflows\//);
  });
});
