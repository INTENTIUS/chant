/**
 * An Op waves spec's `control` on Forgejo (#4617): github's control job
 * under the dialect, dispatching the control repo's dependents workflow by
 * name with the outcome as an input. Written for the ci-products session;
 * run at epic-ready.
 */

import { describe, expect, test } from "vitest";
import type { OpWavesSpec } from "@intentius/chant/op/op-waves";
import { generateForgejoOpWavesPipeline } from "./generate-op-waves-pipeline";

const spec: OpWavesSpec = {
  name: "stacks",
  op: "pulumi-up",
  plan: ["./bin/plan", "{target}", "{plan}"],
  waves: [{ name: "all", runs: [{ target: "dev" }, { target: "prod" }] }],
  control: { repo: "forgejo.example.com/acme/control", op: "deploy", member: "network", ref: "trunk" },
};

const options = { specFile: "waves.json", bin: "npx --no-install plywood", words: { product: "plywood" } };

describe("the control dispatch after the last wave on Forgejo (#4617)", () => {
  test("a workflow dispatch of the control repo's dependents file, the outcome among its inputs", () => {
    const yaml = generateForgejoOpWavesPipeline(spec, options).files[0]!.yaml;
    expect(yaml).toMatch(/control-dispatch:[\s\S]*needs:\n\s+- wave-1-all\n\s+if: '!cancelled\(\)'/);
    expect(yaml).toContain("https://forgejo.example.com/api/v1/repos/acme/control/actions/workflows/plywood-dependents.yml/dispatches");
    expect(yaml).toContain(`{"ref":"trunk","inputs":{"member":"'"$member"'","op":"'"$op"'","sha":"'"$sha"'","outcome":"'"$outcome"'"}}`);
    expect(yaml).toContain("Authorization: token %s");
    expect(yaml).toContain("CHANT_CONTROL_TOKEN: '${{ secrets.CHANT_CONTROL_TOKEN }}'");
    expect(yaml).toContain("npx --no-install plywood run wave --spec waves.json --waves-outcome");
  });

  test("the dialect drops permissions and rewrites the download action", () => {
    const yaml = generateForgejoOpWavesPipeline(spec, options).files[0]!.yaml;
    expect(yaml).not.toContain("permissions:");
    expect(yaml).toContain("name: Download the waves' outcomes");
  });
});
