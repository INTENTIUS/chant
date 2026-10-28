/**
 * The merge request pipeline's runners, variables and passed secrets on
 * GitLab (#4625): each job's `tags` from its stage's runner, and a passed
 * secret mapped from the CI/CD variable when the names differ. Written for
 * the ci-products post-merge pass.
 */

import { describe, expect, test } from "vitest";
import { parseYAML } from "@intentius/chant/yaml";
import type { DriverComponent } from "@intentius/chant/components/driver";
import { generateGitlabPipeline } from "./generate-pipeline";

const ESTATE: DriverComponent[] = [{ name: "net", dependsOn: [], deploy: [{ phase: "Apply", steps: [{ kind: "terraform-apply", root: "net" }] }] }];

type Job = { tags?: string[]; variables: Record<string, string>; script: string[] };
type Doc = Record<string, Job>;

describe("the GitLab merge request pipeline's runners and variables (#4625)", () => {
  const doc = parseYAML(
    generateGitlabPipeline(ESTATE, {
      env: "prod",
      prLoop: { applyOnMerge: true, runners: { plan: "planner", apply: ["deploy", "eu"], default: "small" }, variables: { REGION: "eu" }, secrets: { DB_PASSWORD: "PROD_DB", SAME: "SAME" } },
    }).yaml,
  ) as Doc;

  test("each job's tags come from its stage", () => {
    expect(doc.plan!.tags).toEqual(["planner"]);
    expect(doc.apply!.tags).toEqual(["deploy", "eu"]);
    expect(doc.record!.tags).toEqual(["deploy", "eu"]);
    expect(doc["plan-note"]!.tags).toEqual(["small"]);
  });

  test("the plan's variables carry the variable and the renamed secret; a same-named one needs no line", () => {
    expect(doc.plan!.variables).toMatchObject({ REGION: "eu", DB_PASSWORD: "$PROD_DB" });
    expect(doc.plan!.variables).not.toHaveProperty("SAME");
  });

  test("a runner group is refused", () => {
    expect(() => generateGitlabPipeline(ESTATE, { env: "prod", prLoop: { runners: { plan: { group: "g" } } } })).toThrow(/runner group/);
  });
});
