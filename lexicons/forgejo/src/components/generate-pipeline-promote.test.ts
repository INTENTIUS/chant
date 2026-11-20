import { describe, expect, test } from "vitest";
import { parseYAML } from "@intentius/chant/yaml";
import type { PipelinePromoteInput } from "@intentius/chant/lexicon";
import { generateForgejoPipelinePromote } from "./generate-pipeline-promote";
import { forgejoPlugin } from "../plugin";

const input: PipelinePromoteInput = {
  pipeline: "shop",
  stages: [
    { name: "staging", environment: { name: "staging" } },
    { name: "prod", environment: { name: "prod", url: "https://shop.example" } },
  ],
  bin: "npx --no-install plywood",
};

const yaml = (i: PipelinePromoteInput) => generateForgejoPipelinePromote(i)[0]!.yaml;

describe("forgejo pipeline promote", () => {
  test("golden", async () => {
    await expect(yaml(input)).toMatchFileSnapshot("./__golden__/pipeline-promote.forgejo.yml");
  });

  test("file name and one job per stage", () => {
    const files = generateForgejoPipelinePromote(input);
    expect(files.map((f) => f.name)).toEqual(["shop-promote.yml"]);
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
    expect(out).not.toContain("environment:\n");
    expect(out).toContain("Forgejo Actions has no environments");
  });

  test("refuses no stages and a bad name", () => {
    expect(() => yaml({ ...input, stages: [] })).toThrow(/no stages/);
    expect(() => yaml({ ...input, stages: [{ name: "Prod" }] })).toThrow(/not a valid name/);
  });

  test("recheck (#5326): a schedule and a recheck job per stage, golden", async () => {
    const out = yaml({ ...input, recheck: { schedule: "0 * * * *" } });
    await expect(out).toMatchFileSnapshot("./__golden__/pipeline-promote-recheck.forgejo.yml");
    expect(out).toContain("cron: '0 * * * *'");
    expect(out).toContain("components promote --to prod --pending");
    expect(yaml(input)).not.toContain("recheck-");
  });

  test("the plugin exposes it", () => {
    expect(forgejoPlugin.generatePipelinePromote!(input)).toHaveLength(1);
  });
});

// #5339: with agentFacts, the promote and recheck steps record failed verifies and soaks for the verify-failed agent.
describe("forgejo pipeline promote: the verify-failed facts", () => {
  test("the command step holds CHANT_AGENT_FACTS=verify-failed and the relay key; without agentFacts, nothing", () => {
    const doc = parseYAML(yaml({ ...input, recheck: { schedule: "0 * * * *" }, agentFacts: { relayKeyEnv: "OPS_RELAY" } })) as unknown as { jobs: Record<string, { steps: Array<{ run?: string; env?: Record<string, string> }> }> };
    for (const name of ["promote-staging", "promote-prod", "recheck-staging", "recheck-prod"]) {
      const step = doc.jobs[name]!.steps.find((s) => s.run?.includes("components promote"))!;
      expect(step.env, name).toMatchObject({ CHANT_AGENT_FACTS: "verify-failed", CHANT_RELAY_KEY: "${{ secrets.OPS_RELAY }}" });
    }
    expect(yaml(input)).not.toContain("CHANT_AGENT_FACTS");
  });
});
