/**
 * #4870 on github: with a runner identity the product plan pipeline signs the
 * plan job's plan and policy checks, and each deciding wave job gets the
 * runner key on its `chant run wave` step. Without one, the files are
 * byte for byte those generated before.
 */
import { describe, expect, test } from "vitest";
import type { OpWavesSpec } from "@intentius/chant/op/op-waves";
import { generateProductPlanPipeline } from "./product-plan-pipeline";
import { generateGithubOpWavesPipeline } from "./generate-op-waves-pipeline";

const words = { product: "yodel", noun: ["environment", "environments"] as [string, string], commands: {}, approve: "yodel approve {target} --plan {digest} {sign}", op: "yodel-apply", gateName: "yodel-apply-wave-{k}", approval: "per-wave" as const, bin: "yodel chant" };
const plan = { words, productPlan: { command: "yodel plan {target} --pr-note {output}", targets: [{ name: "staging" }, { name: "prod" }] } };
const evidence = { runnerKeySecret: "CHANT_RUNNER_KEY_PEM" };
const spec: OpWavesSpec = { name: "roots", op: "tf-apply", step: { kind: "terraform-apply", root: "{target}" }, waves: [{ name: "dev", runs: [{ target: "network" }] }, { name: "prod", runs: [{ target: "network" }, { target: "app" }], shares: 2 }] };
const waves = { specFile: ".chant/op-waves/roots.spec.json" };

describe("check evidence in generated pipelines on github (#4870)", () => {
  test("without a runner identity the files are unchanged", () => {
    expect(generateProductPlanPipeline("default", { ...plan, evidence: undefined }).yaml).toBe(generateProductPlanPipeline("default", plan).yaml);
    expect(generateProductPlanPipeline("default", plan).yaml).not.toContain("ci evidence");
    expect(generateGithubOpWavesPipeline(spec, waves).files.map((f) => f.yaml).join("\n")).not.toContain("CHANT_RUNNER_KEY");
  });

  test("the plan pipeline signs plan and policy for each target, with the key from the secret", () => {
    const yaml = generateProductPlanPipeline("default", { ...plan, evidence }).yaml;
    expect(yaml.match(/yodel chant ci evidence sign --from-report \.chant\/pr --result /g)).toHaveLength(2);
    expect(yaml).toContain("CHANT_RUNNER_KEY:");
    expect(yaml).toContain("CHANT_RUNNER_KEY_PEM");
    expect(yaml).toContain("refs/heads/chant/lifecycle");
  });

  test("each deciding wave job's command step carries the key, and a share job's does not", () => {
    const yaml = generateGithubOpWavesPipeline(spec, { ...waves, evidence }).files[0]!.yaml;
    // Wave 1 (one job) and wave 2's deciding job; wave 2's two share jobs plan again and sign nothing.
    expect(yaml.match(/CHANT_RUNNER_KEY:/g)).toHaveLength(2);
  });

  test("a secret name the forge could not hold is refused", () => {
    expect(() => generateProductPlanPipeline("default", { ...plan, evidence: { runnerKeySecret: "not a name" } })).toThrow(/not a secret name/);
    expect(() => generateGithubOpWavesPipeline(spec, { ...waves, evidence: { runnerKeySecret: "1X" } })).toThrow(/not a secret name/);
  });
});
