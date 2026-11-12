/**
 * #5044: `commandToken` hands a GitHub or Forgejo wave job's command step
 * the job's token. GitLab's jobs read `CHANT_FORGE_TOKEN`, a CI/CD
 * variable, so the GitLab generator refuses it.
 */
import { describe, expect, test } from "vitest";
import type { OpWavesSpec } from "@intentius/chant/op/op-waves";
import { generateGitlabOpWavesPipeline } from "./generate-op-waves-pipeline";

const spec = { name: "tf-apply", op: "tf-apply", planWave: ["p", "{runs}", "{plans}"], apply: ["a", "{target}"], waves: [{ name: "canary", runs: [], discover: true }] } as unknown as OpWavesSpec;

describe("the wave jobs' command token on GitLab (#5044)", () => {
  test("refused", () => {
    expect(() => generateGitlabOpWavesPipeline(spec, { specFile: "w.json", commandToken: { permissions: { "pull-requests": "write" } } })).toThrow(/a GitLab job reads CHANT_FORGE_TOKEN/);
  });
});
