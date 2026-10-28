/**
 * The pull request loop's runners and passed secrets on Forgejo (#4625):
 * the GitHub generator's, through the dialect. Written for the ci-products
 * post-merge pass.
 */

import { describe, expect, test } from "vitest";
import { parseYAML } from "@intentius/chant/yaml";
import type { DriverComponent } from "@intentius/chant/components/driver";
import { generateForgejoPipeline } from "./generate-pipeline";

const ESTATE: DriverComponent[] = [{ name: "net", dependsOn: [], deploy: [{ phase: "Apply", steps: [{ kind: "terraform-apply", root: "net" }] }] }];

type Doc = { jobs: Record<string, { "runs-on": unknown; steps: Array<{ name?: string; env?: Record<string, string> }> }> };

describe("the Forgejo pull request loop's runners and secrets (#4625)", () => {
  test("the plan runs on its stage's runner with the passed secret", () => {
    const doc = parseYAML(generateForgejoPipeline(ESTATE, { env: "prod", prLoop: { runners: { plan: "big", default: "small" }, secrets: { DB_PASSWORD: "PROD_DB" } } }).yaml) as Doc;
    expect(doc.jobs.plan!["runs-on"]).toBe("big");
    expect(doc.jobs["plan-note"]!["runs-on"]).toBe("small");
    const step = doc.jobs.plan!.steps.find((s) => s.name === "Plan the members this pull request reaches")!;
    expect(step.env).toMatchObject({ DB_PASSWORD: "${{ secrets.PROD_DB }}" });
  });
});
