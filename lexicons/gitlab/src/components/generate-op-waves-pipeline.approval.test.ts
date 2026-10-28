/** #4630: GitLab approvals start no pipeline, so a schedule posts every open merge request's approval status. */
import { describe, expect, test } from "vitest";
import type { OpWavesSpec } from "@intentius/chant/op/op-waves";
import { generateGitlabOpWavesPipeline } from "./generate-op-waves-pipeline";

const spec: OpWavesSpec = {
  name: "plywood-up",
  op: "plywood-up",
  plan: ["./bin/plan", "{target}", "{plan}"],
  waves: [{ name: "prod", runs: [{ target: "app" }], approval: "pr-review" }],
};

describe("the approval status job on GitLab (#4630)", () => {
  test("runs in a schedule that sets CHANT_APPROVAL_STATUS, with --open", () => {
    const yaml = generateGitlabOpWavesPipeline(spec, { specFile: "waves.json" }).files[0]!.yaml;
    expect(yaml).toContain("plywood-up-approval-status:");
    expect(yaml).toContain('$CI_PIPELINE_SOURCE == "schedule" && $CHANT_APPROVAL_STATUS == "1"');
    expect(yaml).toContain("chant run wave --spec waves.json --approval-status --open --forge gitlab");
  });
});
