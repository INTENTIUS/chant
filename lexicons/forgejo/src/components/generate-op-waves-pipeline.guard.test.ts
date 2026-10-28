/**
 * The apply-job guard in Forgejo op-wave jobs (#4624): the GitHub step with
 * the forge set to Forgejo, which checks the ref and runner and no
 * environment. Written for the ci-products post-merge pass.
 */

import { describe, expect, test } from "vitest";
import type { OpWavesSpec } from "@intentius/chant/op/op-waves";
import { JOB_GUARD_ENV } from "@intentius/chant/ci-job-guard";
import { generateForgejoOpWavesPipeline } from "./generate-op-waves-pipeline";

const spec: OpWavesSpec = {
  name: "deploy",
  op: "pulumi-up",
  plan: ["./bin/plan", "{target}", "{plan}"],
  runner: ["self-hosted", "docker"],
  waves: [{ name: "prod", runs: [{ target: "prod" }], environment: { name: "production" }, idTokens: { CLOUD_TOKEN: "aud" } }],
};

describe("the apply-job guard on Forgejo (#4624)", () => {
  test("the first step of the wave job, with the forge set to Forgejo and no environment", () => {
    const yaml = generateForgejoOpWavesPipeline(spec, { specFile: "waves.json" }).files[0]!.yaml;
    const steps = yaml.slice(yaml.indexOf("steps:"));
    expect(steps.indexOf("Check the job runs where the spec set it to run")).toBeLessThan(steps.indexOf("checkout"));
    expect(yaml).toContain(JOB_GUARD_ENV);
    const json = /CHANT_JOB_GUARD: '(\{.*?\})'/.exec(yaml)?.[1] ?? /CHANT_JOB_GUARD: "(.*?)"\n/.exec(yaml)?.[1]?.replace(/\\"/g, '"');
    expect(json).toBeDefined();
    const guard = JSON.parse(json!) as Record<string, unknown>;
    expect(guard).toEqual({ forge: "forgejo", job: "wave 1 (prod) of deploy", branches: ["main"], selfHosted: true });
  });
});
