/**
 * The apply-job guard in GitLab op-wave jobs (#4624): the script's first
 * line, before the trade, with the job's expectation in a variable: the
 * environment, the branches and the runner's tags. Written for the
 * ci-products post-merge pass.
 */

import { describe, expect, test } from "vitest";
import type { OpWavesSpec } from "@intentius/chant/op/op-waves";
import { JOB_GUARD_ENV, JOB_GUARD_JS } from "@intentius/chant/ci-job-guard";
import { generateGitlabOpWavesPipeline } from "./generate-op-waves-pipeline";

const spec: OpWavesSpec = {
  name: "deploy",
  op: "pulumi-up",
  plan: ["./bin/plan", "{target}", "{plan}"],
  branches: ["main"],
  runner: ["deploy"],
  waves: [
    { name: "dev", runs: [{ target: "dev" }], gate: "never" },
    { name: "prod", runs: [{ target: "prod" }], environment: { name: "production" } },
  ],
};

describe("the apply-job guard on GitLab (#4624)", () => {
  test("the first script line of every wave job", () => {
    const yaml = generateGitlabOpWavesPipeline(spec, { specFile: "waves.json", words: { product: "plywood" } }).files[0]!.yaml;
    for (const job of ["wave-1-dev", "wave-2-prod"]) {
      const body = yaml.slice(yaml.indexOf(`${job}:`));
      const script = body.slice(body.indexOf("script:"));
      expect(script.split("\n")[1]).toContain(JOB_GUARD_JS.slice(0, 40));
    }
  });

  test("the variable names the environment, the branches, the tags and the product", () => {
    const yaml = generateGitlabOpWavesPipeline(spec, { specFile: "waves.json", words: { product: "plywood" } }).files[0]!.yaml;
    const prod = yaml.slice(yaml.indexOf("wave-2-prod:"));
    expect(prod).toContain(JOB_GUARD_ENV);
    for (const part of ['"forge":"gitlab"', '"forgeEnvironment":"production"', '"branches":["main"]', '"runnerTags":["deploy"]', '"product":"plywood"', '"job":"wave 2 (prod) of deploy"']) {
      expect(prod).toContain(part);
    }
  });
});
