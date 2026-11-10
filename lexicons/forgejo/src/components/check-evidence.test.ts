/**
 * #4870 on forgejo: with a runner identity the product plan pipeline signs the
 * plan job's plan and policy checks, and each deciding wave job gets the
 * runner key on its `chant run wave` step. Without one, the files are
 * byte for byte those generated before.
 */
import { describe, expect, test } from "vitest";
import type { OpWavesSpec } from "@intentius/chant/op/op-waves";
import { generateForgejoProductPlanPipeline } from "./product-plan-pipeline";
import { generateForgejoOpWavesPipeline } from "./generate-op-waves-pipeline";

const words = { product: "yodel", noun: ["environment", "environments"] as [string, string], commands: {}, approve: "yodel approve {target} --plan {digest} {sign}", op: "yodel-apply", gateName: "yodel-apply-wave-{k}", approval: "per-wave" as const, bin: "yodel chant" };
const plan = { words, productPlan: { command: "yodel plan {target} --pr-note {output}", targets: [{ name: "staging" }, { name: "prod" }] } };
const evidence = { runnerKeySecret: "CHANT_RUNNER_KEY_PEM" };
const spec: OpWavesSpec = { name: "roots", op: "tf-apply", step: { kind: "terraform-apply", root: "{target}" }, waves: [{ name: "dev", runs: [{ target: "network" }] }, { name: "prod", runs: [{ target: "network" }, { target: "app" }], shares: 2 }] };
const waves = { specFile: ".chant/op-waves/roots.spec.json" };

describe("check evidence in generated pipelines on forgejo (#4870)", () => {
  test("without a runner identity the files are unchanged", () => {
    expect(generateForgejoProductPlanPipeline("default", { ...plan, evidence: undefined }).yaml).toBe(generateForgejoProductPlanPipeline("default", plan).yaml);
    expect(generateForgejoProductPlanPipeline("default", plan).yaml).not.toContain("ci evidence");
    expect(generateForgejoOpWavesPipeline(spec, waves).files.map((f) => f.yaml).join("\n")).not.toContain("CHANT_RUNNER_KEY");
  });

  test("the plan pipeline signs plan:<target> and policy:<target> for each target, with the key from the secret (#4978)", () => {
    const yaml = generateForgejoProductPlanPipeline("default", { ...plan, evidence }).yaml;
    expect(yaml.match(/yodel chant ci evidence sign --from-report \.chant\/pr --member (staging|prod) --result /g)).toHaveLength(2);
    expect(yaml).toContain("--member staging --result");
    expect(yaml).toContain("--member prod --result");
    expect(yaml).toContain("CHANT_RUNNER_KEY:");
    expect(yaml).toContain("CHANT_RUNNER_KEY_PEM");
    expect(yaml).toContain("git fetch --quiet --no-tags --depth=1 origin");
  });

  test("each deciding wave job's command step carries the key, and a share job's does not", () => {
    const yaml = generateForgejoOpWavesPipeline(spec, { ...waves, evidence }).files[0]!.yaml;
    // Wave 1 (one job) and wave 2's deciding job; wave 2's two share jobs plan again and sign nothing.
    expect(yaml.match(/CHANT_RUNNER_KEY:/g)).toHaveLength(2);
  });

  test("a secret name the forge could not hold is refused", () => {
    expect(() => generateForgejoProductPlanPipeline("default", { ...plan, evidence: { runnerKeySecret: "not a name" } })).toThrow(/not a secret name/);
    expect(() => generateForgejoOpWavesPipeline(spec, { ...waves, evidence: { runnerKeySecret: "1X" } })).toThrow(/not a secret name/);
  });

  test("#4869: signing keyless, each target's note job and each deciding wave job get enable-openid-connect, and no secret is named", () => {
    const keyless = { identity: "oidc" as const };
    const plan_ = generateForgejoProductPlanPipeline("default", { ...plan, evidence: keyless }).yaml;
    expect(plan_).toContain("CHANT_RUNNER_IDENTITY: oidc");
    expect(plan_).not.toContain("CHANT_RUNNER_KEY");
    expect(plan_.match(/enable-openid-connect: true/g)).toHaveLength(2);
    const yaml = generateForgejoOpWavesPipeline(spec, { ...waves, evidence: keyless }).files[0]!.yaml;
    expect(yaml.match(/CHANT_RUNNER_IDENTITY: oidc/g)).toHaveLength(2);
    expect(yaml.match(/enable-openid-connect: true/g)).toHaveLength(2);
  });
});
