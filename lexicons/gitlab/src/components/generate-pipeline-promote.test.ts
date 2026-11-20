import { describe, expect, test } from "vitest";
import { parseYAML } from "@intentius/chant/yaml";
import type { PipelinePromoteInput } from "@intentius/chant/lexicon";
import { generateGitlabPipelinePromote } from "./generate-pipeline-promote";
import { gitlabPlugin } from "../plugin";

const input: PipelinePromoteInput = {
  pipeline: "shop",
  stages: [
    { name: "staging", environment: { name: "staging" } },
    { name: "prod", environment: { name: "prod", url: "https://shop.example" } },
  ],
  bin: "npx --no-install plywood",
};

const yaml = (i: PipelinePromoteInput) => generateGitlabPipelinePromote(i)[0]!.yaml;

describe("gitlab pipeline promote", () => {
  test("golden", async () => {
    await expect(yaml(input)).toMatchFileSnapshot("./__golden__/pipeline-promote.gitlab.yml");
  });

  test("file name and one job per stage", () => {
    const files = generateGitlabPipelinePromote(input);
    expect(files.map((f) => f.name)).toEqual(["shop-promote.gitlab-ci.yml"]);
    expect(files[0]!.yaml).toContain("promote-staging:");
    expect(files[0]!.yaml).toContain("promote-prod:");
  });

  test("bin and default bin", () => {
    expect(yaml(input)).toContain('npx --no-install plywood components promote --to prod --release "$CHANT_PROMOTE_RELEASE"');
    expect(yaml({ ...input, bin: undefined })).toContain('chant components promote --to staging --release "$CHANT_PROMOTE_RELEASE"');
  });

  test("runner", () => {
    expect(yaml({ ...input, runner: "big-box" })).toContain("big-box");
  });

  test("environment", () => {
    const out = yaml(input);
    expect(out).toContain("environment:");
    expect(out).toContain("https://shop.example");
  });

  test("refuses no stages and a bad name", () => {
    expect(() => yaml({ ...input, stages: [] })).toThrow(/no stages/);
    expect(() => yaml({ ...input, stages: [{ name: "Prod" }] })).toThrow(/not a valid name/);
  });

  test("recheck (#5326): a recheck job per stage on scheduled pipelines, golden", async () => {
    const out = yaml({ ...input, recheck: { schedule: "0 * * * *" } });
    await expect(out).toMatchFileSnapshot("./__golden__/pipeline-promote-recheck.gitlab.yml");
    expect(out).toContain("recheck-staging:");
    expect(out).toContain('$CI_PIPELINE_SOURCE == "schedule"');
    expect(out).toContain("components promote --to prod --pending");
    expect(yaml(input)).not.toContain("recheck-");
  });

  test("the plugin exposes it", () => {
    expect(gitlabPlugin.generatePipelinePromote!(input)).toHaveLength(1);
  });
});

// #5339: with agentFacts, the promote and recheck jobs record failed verifies and soaks for the verify-failed agent.
describe("gitlab pipeline promote: the verify-failed facts", () => {
  test("each job's variables hold CHANT_AGENT_FACTS=verify-failed and the relay key; without agentFacts, nothing", () => {
    const doc = parseYAML(yaml({ ...input, recheck: { schedule: "0 * * * *" }, agentFacts: { relayKeyEnv: "OPS_RELAY" } })) as unknown as Record<string, { variables?: Record<string, string> }>;
    for (const name of ["promote-staging", "promote-prod", "recheck-staging", "recheck-prod"]) {
      expect(doc[name]!.variables, name).toMatchObject({ CHANT_AGENT_FACTS: "verify-failed", CHANT_RELAY_KEY: "$OPS_RELAY" });
    }
    expect(yaml(input)).not.toContain("CHANT_AGENT_FACTS");
  });
});

// #5427: a stage whose command requests the forge's OIDC token itself, with no cloud trade.
describe("gitlab pipeline promote: idTokens", () => {
  type Doc = Record<string, { id_tokens?: Record<string, { aud: string }>; script?: string[] }>;
  const doc = (i: PipelinePromoteInput) => parseYAML(yaml(i)) as unknown as Doc;

  test("the job declares them in id_tokens, with no trade", () => {
    const out = doc({ ...input, stages: [{ name: "staging", idTokens: { AWS_ID_TOKEN: "sts.amazonaws.com" } }, { name: "prod" }] });
    expect(out["promote-staging"]!.id_tokens).toEqual({ AWS_ID_TOKEN: { aud: "sts.amazonaws.com" } });
    expect(out["promote-staging"]!.script!.join("\n")).not.toContain("unset");
    expect(out["promote-prod"]!.id_tokens).toBeUndefined();
  });

  test("beside a trade, both are declared, and a name the trade declares is refused", () => {
    const cloud = { aws: { role: "arn:aws:iam::1:role/apply", region: "us-east-1", audience: "sts.amazonaws.com" } };
    const out = doc({ ...input, stages: [{ name: "staging", cloud, idTokens: { DB_TOKEN: "rds" } }] });
    expect(out["promote-staging"]!.id_tokens).toEqual({ CHANT_ID_TOKEN_AWS: { aud: "sts.amazonaws.com" }, DB_TOKEN: { aud: "rds" } });
    expect(() => yaml({ ...input, stages: [{ name: "staging", cloud, idTokens: { CHANT_ID_TOKEN_AWS: "x" } }] })).toThrow(/declares for the stage's cloud trade/);
  });

  test("idTokens that are not { variable: audience } are refused", () => {
    expect(() => yaml({ ...input, stages: [{ name: "staging", idTokens: { "1BAD": "aud" } }] })).toThrow(/not a variable name/);
  });
});
