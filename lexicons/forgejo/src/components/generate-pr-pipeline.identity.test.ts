/**
 * #4296 on Forgejo: the dialect keeps `id-token: write` on the jobs that
 * trade, the plan job trades for the plan identity before its checkout, and
 * the plan job names no apply identity. The steps are github's, which
 * lexicons/github's identity test runs against the emulator.
 */

import { describe, expect, test } from "vitest";
import { parseYAML } from "@intentius/chant/yaml";
import type { DriverComponent } from "@intentius/chant/components/driver";
import { dropForgeTokens } from "@intentius/chant/ci-handover";
import { OIDC_REQUEST_VARS, resolveCloudIdentity, TRADE_SPEC_ENV, tradeIdentities } from "@intentius/chant/ci-identity";
import { generateForgejoPipeline } from "./generate-pipeline";

const ESTATE: DriverComponent[] = [{ name: "net", dependsOn: [], deploy: [{ phase: "Apply", steps: [{ kind: "terraform-apply", root: "net" }] }] }];

const IDENTITY = resolveCloudIdentity(
  { gcp: { provider: "projects/123/locations/global/workloadIdentityPools/ci/providers/forgejo", rules: [{ plan: "plan@test.iam.gserviceaccount.com", apply: "apply@test.iam.gserviceaccount.com" }] } },
  "prod",
)!;

interface Job {
  permissions?: Record<string, string>;
  steps: Array<{ name?: string; run?: string; env?: Record<string, string> }>;
}

describe("the generated Forgejo jobs' cloud identities (#4296)", () => {
  const { yaml } = generateForgejoPipeline(ESTATE, { env: "prod", prLoop: { applyOnMerge: true, identity: IDENTITY } });
  const jobs = (parseYAML(yaml) as { jobs: Record<string, Job> }).jobs;

  test("the jobs that trade keep id-token: write and nothing else", () => {
    for (const name of ["plan", "record", "apply"]) expect(jobs[name]!.permissions, name).toEqual({ "id-token": "write" });
    expect(jobs["plan-note"]!.permissions).toBeUndefined();
  });

  test("the plan job trades for the plan identity first, drops the request variables after its checkout, and names no apply identity", () => {
    const plan = jobs.plan!;
    expect(plan.steps[0]!.name).toBe("Trade the job's OIDC token for the plan identity");
    expect(JSON.parse(plan.steps[0]!.env![TRADE_SPEC_ENV]!)).toEqual(IDENTITY.plan);
    expect(plan.steps[1]!.name).toBe("Check out the change");
    for (const step of plan.steps.slice(2)) expect(step.run!.split("\n")[0]).toBe(dropForgeTokens("sh", OIDC_REQUEST_VARS));
    for (const id of tradeIdentities(IDENTITY.apply)) expect(JSON.stringify(plan)).not.toContain(id);
  });

  test("the apply job trades for the apply identity", () => {
    expect(JSON.parse(jobs.apply!.steps[0]!.env![TRADE_SPEC_ENV]!)).toEqual(IDENTITY.apply);
  });
});
