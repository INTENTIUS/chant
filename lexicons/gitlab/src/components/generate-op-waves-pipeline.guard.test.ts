/**
 * The apply-job guard in GitLab op-wave jobs (#4624): the script's first
 * line, before the trade, with the job's expectation in a variable: the
 * environment, the branches and the runner's tags. Written for the
 * ci-products post-merge pass.
 */

import { describe, expect, test } from "vitest";
import type { OpWavesSpec } from "@intentius/chant/op/op-waves";
import { spawnSync } from "node:child_process";
import { JOB_GUARD_ENV, JOB_GUARD_JS } from "@intentius/chant/ci-job-guard";
import { CHANT_EXIT } from "@intentius/chant/exit-codes";
import { generateGitlabOpWavesPipeline, OP_WAVE_ALLOWED_EXIT } from "./generate-op-waves-pipeline";

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

  test("a refused guard fails the job and stops the wave (#4624 ruling: fail hard)", () => {
    const yaml = generateGitlabOpWavesPipeline(spec, { specFile: "waves.json", words: { product: "plywood" } }).files[0]!.yaml;
    const prod = yaml.slice(yaml.indexOf("wave-2-prod:"));
    expect(prod).toContain(`exit_codes:\n      - ${OP_WAVE_ALLOWED_EXIT}`);
    const guard = { forge: "gitlab", job: "wave 2 (prod) of deploy", forgeEnvironment: "production", branches: ["main"], runnerTags: ["deploy"] };
    const r = spawnSync(process.execPath, ["-e", JOB_GUARD_JS], {
      env: { PATH: process.env.PATH ?? "", [JOB_GUARD_ENV]: JSON.stringify(guard), CI_ENVIRONMENT_NAME: "dev", CI_COMMIT_REF_NAME: "main", CI_COMMIT_REF_PROTECTED: "true", CI_RUNNER_TAGS: "deploy" },
      encoding: "utf-8",
    });
    expect(r.status).toBe(CHANT_EXIT.misplaced);
    expect(r.status).not.toBe(OP_WAVE_ALLOWED_EXIT);
  });

  test("a guard with no spec to read fails the job too", () => {
    const r = spawnSync(process.execPath, ["-e", JOB_GUARD_JS], { env: { PATH: process.env.PATH ?? "" }, encoding: "utf-8" });
    expect(r.status).toBe(CHANT_EXIT.misplaced);
  });
});
