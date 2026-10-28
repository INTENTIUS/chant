/**
 * #4630: a pr-review wave's plans workflow posts `<product>/approval` on the
 * head after the plans are recorded and on every review, with a token that
 * reads and writes statuses only.
 */
import { describe, expect, test } from "vitest";
import type { OpWavesSpec } from "@intentius/chant/op/op-waves";
import { generateGithubOpWavesPipeline } from "./generate-op-waves-pipeline";

const spec: OpWavesSpec = {
  name: "plywood-up",
  op: "plywood-up",
  plan: ["./bin/plan", "{target}", "{plan}"],
  waves: [{ name: "prod", runs: [{ target: "app" }], approval: "pr-review" }],
};

describe("the approval status job (#4630)", () => {
  test("runs after record-plans on a push and alone on a review, with a read token", () => {
    const { files } = generateGithubOpWavesPipeline(spec, { specFile: ".chant/op-waves/plywood-up.spec.json", bin: "npx --no-install plywood" });
    const plans = files.find((f) => f.name === "plywood-up-plans.yml")!.yaml;
    expect(plans).toContain("pull_request_review:");
    expect(plans).toMatch(/types:\n\s+- submitted\n\s+- dismissed/);
    expect(plans).toContain("github.event_name == 'pull_request'");
    expect(plans).toMatch(/approval-status:\n(.*\n)*?\s+needs:\n\s+- record-plans/);
    expect(plans).toMatch(/permissions:\n\s+contents: read\n\s+pull-requests: read\n\s+statuses: write/);
    expect(plans).toContain('npx --no-install plywood run wave --spec .chant/op-waves/plywood-up.spec.json --approval-status --pr "$PR_NUMBER" --head "$HEAD_SHA" --base "$BASE_SHA" --forge github');
    expect(plans).toContain("HEAD_SHA: '${{ github.event.pull_request.head.sha }}'");
    expect(plans).toContain("BASE_SHA: '${{ github.event.pull_request.base.sha }}'");
  });

  test("a spec with no pr-review wave has no plans workflow", () => {
    const { files } = generateGithubOpWavesPipeline({ ...spec, waves: [{ name: "prod", runs: [{ target: "app" }] }] }, { specFile: "waves.json" });
    expect(files.map((f) => f.name)).toEqual(["plywood-up.yml"]);
  });

  test("a pull-request wave gets the plans workflow and the status too (2026-10-28 ruling)", () => {
    const pullRequest: OpWavesSpec = { ...spec, waves: [{ name: "prod", runs: [{ target: "app" }], approval: "pull-request" }], approvals: { pullRequest: { gate: "up" } } };
    const { files } = generateGithubOpWavesPipeline(pullRequest, { specFile: "waves.json", bin: "npx --no-install plywood" });
    expect(files.map((f) => f.name)).toEqual(["plywood-up.yml", "plywood-up-plans.yml"]);
    const plans = files.find((f) => f.name === "plywood-up-plans.yml")!.yaml;
    expect(plans).toContain("npx --no-install plywood run wave --spec waves.json --record-plans");
    expect(plans).toContain("--approval-status --pr \"$PR_NUMBER\"");
    // The waves read no review, so they ask for no pull-requests scope.
    expect(files[0]!.yaml).not.toContain("pull-requests: read");
  });
});
