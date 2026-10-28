/**
 * The apply-job guard in GitHub op-wave jobs (#4624): the first step of
 * every wave, deciding and share job, before the trade and the checkout,
 * carrying the job's forge environment, branches and runner. Written for
 * the ci-products post-merge pass.
 */

import { describe, expect, test } from "vitest";
import type { OpWavesSpec } from "@intentius/chant/op/op-waves";
import { JOB_GUARD_ENV, jobGuardLine } from "@intentius/chant/ci-job-guard";
import { buildGithubOpWavesDoc } from "./generate-op-waves-pipeline";

const spec: OpWavesSpec = {
  name: "deploy",
  op: "pulumi-up",
  plan: ["./bin/plan", "{target}", "{plan}"],
  branches: ["main", "release"],
  runner: ["self-hosted", "linux"],
  waves: [
    { name: "dev", runs: [{ target: "dev" }], gate: "never" },
    { name: "prod", runs: [{ target: "prod" }], environment: { name: "production" }, idTokens: { CLOUD_TOKEN: "sts.amazonaws.com" } },
    { name: "wide", runs: [{ target: "a" }, { target: "b" }], shares: 2, environment: { name: "production" } },
  ],
};

type Job = { steps: Array<{ name?: string; env?: Record<string, string>; run?: string; uses?: string }> };
const jobsOf = (s: OpWavesSpec, words?: { product: string }) => buildGithubOpWavesDoc(s, { specFile: "waves.json", ...(words ? { words } : {}) }).doc.jobsDoc as Record<string, Job>;
const guardOf = (job: Job) => JSON.parse(job.steps[0]!.env![JOB_GUARD_ENV]!) as Record<string, unknown>;

describe("the apply-job guard on GitHub (#4624)", () => {
  test("every wave job starts with it, before the checkout", () => {
    const jobs = jobsOf(spec);
    for (const [name, job] of Object.entries(jobs)) {
      expect(job.steps[0]!.run, name).toBe(jobGuardLine());
      expect(job.steps[1]!.uses, name).toMatch(/checkout/);
    }
  });

  test("carries the branches, the runner and, where it can read it, the environment", () => {
    const jobs = jobsOf(spec);
    expect(guardOf(jobs["wave-1-dev"]!)).toEqual({ forge: "github", job: "wave 1 (dev) of deploy", branches: ["main", "release"], selfHosted: true });
    // Its id tokens give the job id-token: write, so the guard reads the environment from a token.
    expect(guardOf(jobs["wave-2-prod"]!)).toMatchObject({ forgeEnvironment: "production" });
    // A job that may request no token cannot be checked for its environment on GitHub.
    expect(guardOf(jobs["wave-3-wide-decide"]!)).not.toHaveProperty("forgeEnvironment");
    expect(guardOf(jobs["wave-3-wide-share-2"]!)).toMatchObject({ job: "share 2 of wave 3 (wide) of deploy" });
  });

  test("names the product", () => {
    expect(guardOf(jobsOf(spec, { product: "plywood" })["wave-1-dev"]!)).toMatchObject({ product: "plywood" });
  });

  test("the default branch when the spec names none", () => {
    const { branches: _b, ...plain } = spec;
    expect(guardOf(jobsOf(plain)["wave-1-dev"]!)).toMatchObject({ branches: ["main"] });
  });
});
