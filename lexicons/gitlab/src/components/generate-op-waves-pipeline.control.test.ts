/**
 * An Op waves spec's `control` on GitLab (#4617): a control stage after the
 * waves, the outcome added up without the token, and every other job
 * dropping the control repo's token variables. Written for the ci-products
 * session; run at epic-ready.
 */

import { describe, expect, test } from "vitest";
import type { OpWavesSpec } from "@intentius/chant/op/op-waves";
import { generateGitlabOpWavesPipeline } from "./generate-op-waves-pipeline";

const spec: OpWavesSpec = {
  name: "stacks",
  op: "pulumi-up",
  plan: ["./bin/plan", "{target}", "{plan}"],
  waves: [
    { name: "canary", runs: [{ target: "dev" }], gate: "never" },
    { name: "rest", runs: [{ target: "a" }] },
  ],
  resume: { schedule: "*/10 * * * *" },
  control: { repo: "gitlab.com/acme/control", op: "deploy", member: "network", tokenSecret: "PLYWOOD_CONTROL_TOKEN" },
};

const options = { specFile: "waves.json", bin: "npx --no-install plywood", words: { product: "plywood" } };

describe("the control dispatch after the last wave on GitLab (#4617)", () => {
  test("a control stage after the waves, needing the last wave's job", () => {
    const yaml = generateGitlabOpWavesPipeline(spec, options).files[0]!.yaml;
    expect(yaml).toMatch(/stages:\n\s+- wave-1-canary\n\s+- wave-2-rest\n\s+- control\n\s+- resume/);
    expect(yaml).toMatch(/control-dispatch:\n\s+stage: control[\s\S]*needs:\n\s+- wave-2-rest\n/);
  });

  test("adds up the outcome in a subshell without the token, then sends it with the commit", () => {
    const yaml = generateGitlabOpWavesPipeline(spec, options).files[0]!.yaml;
    expect(yaml).toContain("unset CHANT_CONTROL_TOKEN CHANT_CONTROL_READ_TOKEN PLYWOOD_CONTROL_TOKEN\n      { :\n      } 1>&2\n      npx --no-install plywood run wave --spec waves.json --waves-outcome");
    expect(yaml).toContain('export CHANT_CONTROL_OUTCOME="$outcome"');
    expect(yaml).toContain('export CHANT_CONTROL_SHA="$CI_COMMIT_SHA"');
    expect(yaml).toContain('CHANT_CONTROL_TOKEN="${PLYWOOD_CONTROL_TOKEN:-}"');
    expect(yaml).toContain("--form 'token=<-'");
    expect(yaml).toContain('--form "variables[CHANT_CONTROL_OUTCOME]=$outcome"');
  });

  test("every wave job and the resume job drop the control repo's token variables first", () => {
    const yaml = generateGitlabOpWavesPipeline(spec, options).files[0]!.yaml;
    expect(yaml).toMatch(/wave-1-canary:[\s\S]*script:\n\s+- unset CHANT_CONTROL_TOKEN CHANT_CONTROL_READ_TOKEN PLYWOOD_CONTROL_TOKEN\n\s+- npx --no-install plywood run wave --spec waves.json --wave 1/);
    expect(yaml).toMatch(/stacks-resume:[\s\S]*script:\n\s+- unset CHANT_CONTROL_TOKEN CHANT_CONTROL_READ_TOKEN PLYWOOD_CONTROL_TOKEN/);
  });

  test("no control, no stage, no unset", () => {
    const { control: _drop, ...plain } = spec;
    const yaml = generateGitlabOpWavesPipeline(plain, options).files[0]!.yaml;
    expect(yaml).not.toContain("control-dispatch");
    expect(yaml).not.toContain("unset CHANT_CONTROL_TOKEN");
  });
});
