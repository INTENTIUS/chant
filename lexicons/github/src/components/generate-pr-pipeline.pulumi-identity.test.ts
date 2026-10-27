/**
 * #4549: with a Pulumi Cloud identity, the GitHub and Forgejo pull-request
 * workflows trade the job's OIDC token for a preview token in the plan and
 * record jobs and an up token in the apply job. No job reads a Pulumi token
 * from the forge's secrets, and the plan job names no up token. Generated
 * YAML only; the trade itself is tested against the fake exchange in
 * packages/core/src/ci-identity-pulumi.test.ts.
 */

import { describe, expect, test } from "vitest";
import { parseYAML } from "@intentius/chant/yaml";
import type { DriverComponent } from "@intentius/chant/components/driver";
import { resolveCloudIdentity, TRADE_SPEC_ENV } from "@intentius/chant/ci-identity";
import { generateGithubPipeline } from "./generate-pipeline";

const ESTATE: DriverComponent[] = [{ name: "app", dependsOn: [], deploy: [{ phase: "Apply", steps: [{ kind: "terraform-apply", root: "app" }] }] }];

const IDENTITY = resolveCloudIdentity({ pulumi: { organization: "acme", rules: [{ plan: "team:preview", apply: "team:deploy" }] } }, "prod")!;

interface Job {
  permissions?: Record<string, string>;
  steps: Array<{ name?: string; run?: string; env?: Record<string, string> }>;
}

for (const forge of ["github", "forgejo"] as const) {
  describe(`the ${forge} workflow's Pulumi Cloud tokens (#4549)`, () => {
    const { yaml } = generateGithubPipeline(ESTATE, { env: "prod", image: "example/ci:1", prLoop: { applyOnMerge: true, forge, identity: IDENTITY } });
    const doc = parseYAML(yaml) as { jobs: Record<string, Job> };
    const tradeOf = (job: Job) => JSON.parse(job.steps[0]!.env![TRADE_SPEC_ENV]!) as Record<string, unknown>;

    test("the plan and record jobs trade for the preview token first, the apply job for the up token", () => {
      expect(tradeOf(doc.jobs.plan!)).toEqual({ pulumi: { token: "team:preview", organization: "acme", audience: "urn:pulumi:org:acme" } });
      expect(tradeOf(doc.jobs.record!)).toEqual(IDENTITY.plan);
      expect(tradeOf(doc.jobs.apply!)).toEqual(IDENTITY.apply);
      for (const name of ["plan", "record", "apply"]) expect(doc.jobs[name]!.permissions!["id-token"], name).toBe("write");
    });

    test("the plan job names no up token, and no job reads a Pulumi token from the forge's secrets", () => {
      expect(JSON.stringify(doc.jobs.plan)).not.toContain("team:deploy");
      expect(yaml).not.toMatch(/secrets\.PULUMI_ACCESS_TOKEN/);
    });
  });
}
