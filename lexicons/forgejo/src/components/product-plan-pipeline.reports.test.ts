/**
 * #5004: the product plan job's `artifacts` are GitLab's `artifacts:paths`
 * and `artifacts:reports`. On GitHub and Forgejo the plan verb is the plan
 * job's last step, so no upload can follow it: both refuse the option, and
 * a plan without it (or with it empty) renders as before.
 */
import { describe, expect, test } from "vitest";
import { generateProductPlanPipeline } from "@intentius/chant-lexicon-github/components/product-plan-pipeline";
import { generateForgejoProductPlanPipeline } from "./product-plan-pipeline";

const words = { product: "terragucci", noun: ["root", "roots"] as [string, string], commands: { plan: "plan" as const }, approval: "per-wave" as const, op: "tf-apply", bin: "terragucci chant" };
const plan = { command: "terragucci plan --pr-note {output}", replan: true, reportDir: "terragucci-report" };
const reports = { reports: { terraform: "{output}/gitlab-terraform.json" } };

describe("the product plan job's artifacts off GitLab (#5004)", () => {
  test("GitHub and Forgejo refuse them", () => {
    expect(() => generateProductPlanPipeline("default", { words, productPlan: { ...plan, artifacts: reports } })).toThrow("the product plan's artifacts are GitLab's artifacts:paths and artifacts:reports; on GitHub and Forgejo the plan verb is the plan job's last step, so leave artifacts out there");
    expect(() => generateForgejoProductPlanPipeline("default", { words, productPlan: { ...plan, artifacts: reports } })).toThrow(/the product plan's artifacts are GitLab's/);
  });

  test("empty artifacts render as none", () => {
    for (const gen of [generateProductPlanPipeline, generateForgejoProductPlanPipeline]) {
      const without = gen("default", { words, productPlan: plan }).yaml;
      expect(gen("default", { words, productPlan: { ...plan, artifacts: {} } }).yaml).toBe(without);
      expect(gen("default", { words, productPlan: { ...plan, artifacts: { paths: [], reports: {} } } }).yaml).toBe(without);
    }
  });
});
