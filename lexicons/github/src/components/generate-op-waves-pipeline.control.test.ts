/**
 * An Op waves spec's `control` (#4617): after the last wave, one job adds up
 * the wave jobs' outcomes and tells the control repo how the waves ended.
 * Written for the ci-products session; run at epic-ready.
 */

import { describe, expect, test } from "vitest";
import type { OpWavesSpec } from "@intentius/chant/op/op-waves";
import { generateGithubOpWavesPipeline } from "./generate-op-waves-pipeline";

const spec: OpWavesSpec = {
  name: "stacks",
  op: "pulumi-up",
  plan: ["./bin/plan", "{target}", "{plan}"],
  waves: [
    { name: "canary", runs: [{ target: "dev" }], gate: "never" },
    { name: "rest", runs: [{ target: "a" }, { target: "b" }], shares: 2 },
  ],
  control: { repo: "github.com/acme/control", op: "deploy", member: "network", tokenSecret: "PLYWOOD_CONTROL_TOKEN" },
};

const options = { specFile: "waves.json", bin: "npx --no-install plywood", words: { product: "plywood" } };

describe("the control dispatch after the last wave (#4617)", () => {
  test("needs the last wave's share jobs and runs after a failure, unless the run was cancelled", () => {
    const yaml = generateGithubOpWavesPipeline(spec, options).files[0]!.yaml;
    expect(yaml).toMatch(/control-dispatch:\n\s+runs-on: ubuntu-latest\n\s+needs:\n\s+- wave-2-rest-share-1\n\s+- wave-2-rest-share-2\n\s+if: '!cancelled\(\)'/);
  });

  test("downloads every outcome file and adds them up through the product's bin", () => {
    const yaml = generateGithubOpWavesPipeline(spec, options).files[0]!.yaml;
    expect(yaml).toContain("name: Download the waves' outcomes");
    expect(yaml).toContain("path: .chant/op-waves/stacks/outcomes");
    expect(yaml).toContain('outcome="$(npx --no-install plywood run wave --spec waves.json --waves-outcome)" || exit 1');
    expect(yaml).toContain('echo "CHANT_CONTROL_OUTCOME=$outcome" >> "$GITHUB_ENV"');
  });

  test("the dispatch step alone holds the token, maps it from the product's secret and pipes it to curl", () => {
    const yaml = generateGithubOpWavesPipeline(spec, options).files[0]!.yaml;
    expect(yaml.match(/secrets\.PLYWOOD_CONTROL_TOKEN/g)).toHaveLength(1);
    expect(yaml).toContain("CHANT_CONTROL_TOKEN: '${{ secrets.PLYWOOD_CONTROL_TOKEN }}'");
    expect(yaml).toContain("CHANT_CONTROL_SHA: '${{ github.sha }}'");
    expect(yaml).toContain("-H @-");
    expect(yaml).toContain('"event_type":"plywood-applied"');
    expect(yaml).toContain(`"outcome":"'"$outcome"'"`);
  });

  test("markSent asks for statuses: write and hands the job token over", () => {
    const yaml = generateGithubOpWavesPipeline({ ...spec, control: { ...spec.control!, markSent: "plywood post status control success" } }, options).files[0]!.yaml;
    expect(yaml).toMatch(/control-dispatch:[\s\S]*permissions:\n\s+contents: write\n\s+statuses: write/);
    expect(yaml).toContain("plywood post status control success");
    expect(yaml).toContain("GITHUB_TOKEN: '${{ github.token }}'");
  });

  test("no control, no job", () => {
    const { control: _drop, ...plain } = spec;
    expect(generateGithubOpWavesPipeline(plain, options).files[0]!.yaml).not.toContain("control-dispatch");
  });

  test("a control without a member is refused, since a spec has no repository name to default it to", () => {
    const { member: _m, ...noMember } = spec.control!;
    expect(() => generateGithubOpWavesPipeline({ ...spec, control: noMember as never }, options)).toThrow(/control\.member/);
  });
});
