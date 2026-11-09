/**
 * The product plan pipeline on GitLab CI (#4799): a plan job per target in
 * the merge request's pipeline, and a note job per target in a pipeline of
 * the target branch, which posts from the plan job's artifact.
 */
import { describe, expect, test } from "vitest";
import { generateGitlabProductPlanPipeline } from "./product-plan-pipeline";

const words = {
  product: "yodel",
  noun: ["environment", "environments"] as [string, string],
  commands: {},
  approve: "yodel approve {target} --plan {digest} {sign}",
  op: "yodel-apply",
  gateName: "yodel-apply-wave-{k}",
  approval: "per-wave" as const,
  bin: "yodel chant",
};

type Job = { stage: string; rules: Array<{ if: string }>; variables?: Record<string, string>; script: string[]; artifacts?: Record<string, unknown>; tags?: string[] };

describe("the product plan pipeline on GitLab (#4799)", () => {
  const { yaml, entries } = generateGitlabProductPlanPipeline("default", {
    words,
    beforeScript: ["yodel ci --fetch-ledger"],
    runners: { plan: "db-readers" },
    productPlan: {
      command: "yodel plan {target} --pr-note {output}",
      workflow: "yodel-pr",
      forks: "skip",
      targets: [
        { name: "staging", secrets: { PG_READER_URL: "STAGING_PG_READER_URL" }, writeProbe: "yodel config check staging --write-probe" },
        { name: "prod", secrets: { PG_READER_URL: "PROD_PG_READER_URL" } },
      ],
    },
  });
  const job = (name: string) => entries.find(([k]) => k === name)![1] as Job;

  test("writes the workflow, the two stages, and a plan and a note job per target", () => {
    expect(entries.map(([k]) => k)).toEqual(["workflow", "stages", "variables", "staging-plan", "prod-plan", "staging-plan-note", "prod-plan-note"]);
    expect(entries[1]![1]).toEqual(["plan", "plan-note"]);
    expect(yaml).toContain("name: yodel-pr");
  });

  test("a plan job drops the forge tokens first, probes, plans with its own target's variable, and keeps its report", () => {
    const staging = job("staging-plan");
    expect(staging.script[0]).toMatch(/^unset /);
    expect(staging.script.slice(-3)).toEqual(["yodel ci --fetch-ledger", "yodel config check staging --write-probe", "yodel plan staging --pr-note .chant/pr"]);
    expect(staging.variables).toEqual({ BASE_SHA: "$CI_MERGE_REQUEST_DIFF_BASE_SHA", PR_NUMBER: "$CI_MERGE_REQUEST_IID", PG_READER_URL: "$STAGING_PG_READER_URL" });
    expect(job("prod-plan").variables!.PG_READER_URL).toBe("$PROD_PG_READER_URL");
    expect(staging.artifacts).toEqual({ name: "chant-pr-plan-staging", when: "always", paths: [".chant/pr"] });
    expect(staging.tags).toEqual(["db-readers"]);
  });

  test("with forks: skip, the plan runs only for the project's own merge requests", () => {
    expect(job("prod-plan").rules).toEqual([{ if: '$CI_PIPELINE_SOURCE == "merge_request_event" && $CI_MERGE_REQUEST_SOURCE_PROJECT_ID == $CI_MERGE_REQUEST_PROJECT_ID' }]);
  });

  test("the note job runs in a pipeline of the target branch and posts the target's note from its plan job", () => {
    const note = job("prod-plan-note");
    expect(note.rules[0]!.if).toContain('$CHANT_PLAN_NOTES == "1"');
    expect(note.script).toEqual(["yodel ci --fetch-ledger", "yodel chant components pr-post --open --env default --output .chant/pr --forge gitlab --member prod"]);
  });
});
