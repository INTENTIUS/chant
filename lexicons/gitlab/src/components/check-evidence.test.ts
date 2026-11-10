/**
 * #4870 on gitlab: with a runner identity the product plan pipeline signs the
 * plan job's plan and policy checks, and each deciding wave job gets the
 * runner key on its `chant run wave` step. Without one, the files are
 * byte for byte those generated before.
 */
import { describe, expect, test } from "vitest";
import type { OpWavesSpec } from "@intentius/chant/op/op-waves";
import { parseYAML } from "@intentius/chant/yaml";
import { generateGitlabProductPlanPipeline } from "./product-plan-pipeline";
import { generateGitlabOpWavesPipeline } from "./generate-op-waves-pipeline";

const words = { product: "yodel", noun: ["environment", "environments"] as [string, string], commands: {}, approve: "yodel approve {target} --plan {digest} {sign}", op: "yodel-apply", gateName: "yodel-apply-wave-{k}", approval: "per-wave" as const, bin: "yodel chant" };
const plan = { words, productPlan: { command: "yodel plan {target} --pr-note {output}", targets: [{ name: "staging" }, { name: "prod" }] } };
const evidence = { runnerKeySecret: "CHANT_RUNNER_KEY_PEM" };
const spec: OpWavesSpec = { name: "roots", op: "tf-apply", step: { kind: "terraform-apply", root: "{target}" }, waves: [{ name: "dev", runs: [{ target: "network" }] }, { name: "prod", runs: [{ target: "network" }, { target: "app" }], shares: 2 }] };
const waves = { specFile: ".chant/op-waves/roots.spec.json" };

describe("check evidence in generated pipelines on gitlab (#4870)", () => {
  test("without a runner identity the files are unchanged", () => {
    expect(generateGitlabProductPlanPipeline("default", { ...plan, evidence: undefined }).yaml).toBe(generateGitlabProductPlanPipeline("default", plan).yaml);
    expect(generateGitlabProductPlanPipeline("default", plan).yaml).not.toContain("ci evidence");
    expect(generateGitlabOpWavesPipeline(spec, waves).files.map((f) => f.yaml).join("\n")).not.toContain("CHANT_RUNNER_KEY");
  });

  test("the plan pipeline signs plan and policy for each target, with the key from the secret", () => {
    const yaml = generateGitlabProductPlanPipeline("default", { ...plan, evidence }).yaml;
    // #4914: in the plan notes pipeline, for every open merge request's plan job.
    expect(yaml.match(/yodel chant ci evidence sign --open --job (staging|prod)-plan --from-report \.chant\/pr /g)).toHaveLength(2);
    expect(yaml).toContain("CHANT_RUNNER_KEY:");
    expect(yaml).toContain("CHANT_RUNNER_KEY_PEM");
  });

  test("no wave job holds the key: each deciding wave job's evidence job signs its plan, in the chant-evidence environment (#4964)", () => {
    type Job = { needs?: string[]; environment?: unknown; variables?: Record<string, string>; script: string[] };
    const doc = parseYAML(generateGitlabOpWavesPipeline(spec, { ...waves, evidence }).files[0]!.yaml) as Record<string, Job>;
    const waveJobs = Object.keys(doc).filter((k) => k.startsWith("wave-") && !k.endsWith("-evidence"));
    expect(waveJobs.length).toBeGreaterThan(2);
    for (const name of waveJobs) expect(JSON.stringify(doc[name]!.variables ?? {}), name).not.toContain("CHANT_RUNNER_KEY");
    // Wave 1 (one job) and wave 2's deciding job; wave 2's two share jobs plan again and sign nothing.
    const signing = Object.keys(doc).filter((k) => k.endsWith("-evidence"));
    expect(signing).toHaveLength(2);
    for (const name of signing) {
      const job = doc[name]!;
      expect(job.environment).toEqual({ name: "chant-evidence", action: "access" });
      expect(job.variables!.CHANT_RUNNER_KEY).toBe("$CHANT_RUNNER_KEY_PEM");
      expect(job.script.at(-1)).toMatch(/^chant ci evidence sign --from-job wave-\d-\S+ --check-id plan:(dev|prod) /);
      expect(doc[job.needs![0]!]!.variables!.CHANT_WAVE_EVIDENCE).toBe("job");
    }
  });

  test("a secret name the forge could not hold is refused", () => {
    expect(() => generateGitlabProductPlanPipeline("default", { ...plan, evidence: { runnerKeySecret: "not a name" } })).toThrow(/not a secret name/);
    expect(() => generateGitlabOpWavesPipeline(spec, { ...waves, evidence: { runnerKeySecret: "1X" } })).toThrow(/not a secret name/);
  });

  test("#4869: signing keyless, each evidence job and each deciding wave job request the signing token, and no secret is named", () => {
    const keyless = { identity: "oidc" as const };
    const plan_ = generateGitlabProductPlanPipeline("default", { ...plan, evidence: keyless }).yaml;
    expect(plan_).toContain("CHANT_RUNNER_IDENTITY: oidc");
    expect(plan_).not.toContain("CHANT_RUNNER_KEY");
    expect(plan_.match(/CHANT_ID_TOKEN_SIGSTORE:\s+aud: sigstore/g)).toHaveLength(2);
    const yaml = generateGitlabOpWavesPipeline(spec, { ...waves, evidence: { ...keyless, audience: "https://fulcio.internal" } }).files[0]!.yaml;
    expect(yaml.match(/CHANT_RUNNER_IDENTITY: oidc/g)).toHaveLength(2);
    expect(yaml.match(/CHANT_ID_TOKEN_SIGSTORE:\s+aud: https:\/\/fulcio\.internal/g)).toHaveLength(2);
  });
});
