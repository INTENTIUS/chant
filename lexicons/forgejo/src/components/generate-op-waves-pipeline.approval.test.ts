/** #4630: the Forgejo plans workflow posts the approval status with `--forge forgejo`. */
import { describe, expect, test } from "vitest";
import type { OpWavesSpec } from "@intentius/chant/op/op-waves";
import { generateForgejoOpWavesPipeline } from "./generate-op-waves-pipeline";

const spec: OpWavesSpec = {
  name: "plywood-up",
  op: "plywood-up",
  plan: ["./bin/plan", "{target}", "{plan}"],
  waves: [{ name: "prod", runs: [{ target: "app" }], approval: "pr-review" }],
};

describe("the approval status job on Forgejo (#4630)", () => {
  test("runs on reviews and after the plans with --forge forgejo", () => {
    const plans = generateForgejoOpWavesPipeline(spec, { specFile: "waves.json" }).files.find((f) => f.name === "plywood-up-plans.yml")!.yaml;
    expect(plans).toContain("pull_request_review:");
    expect(plans).toContain('run wave --spec waves.json --approval-status --pr "$PR_NUMBER" --head "$HEAD_SHA" --base "$BASE_SHA" --forge forgejo');
  });

  test("a pull-request wave gets the plans workflow too (2026-10-28 ruling)", () => {
    const pullRequest: OpWavesSpec = { ...spec, waves: [{ name: "prod", runs: [{ target: "app" }], approval: "pull-request" }], approvals: { pullRequest: { gate: "up" } } };
    const plans = generateForgejoOpWavesPipeline(pullRequest, { specFile: "waves.json" }).files.find((f) => f.name === "plywood-up-plans.yml")!.yaml;
    expect(plans).toContain("run wave --spec waves.json --record-plans");
    expect(plans).toContain("--approval-status --pr");
  });
});
