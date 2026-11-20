import { describe, expect, test } from "vitest";
import type { PipelinePromoteInput } from "@intentius/chant/lexicon";
import { generateGithubPipelinePromote } from "./generate-pipeline-promote";
import { githubPlugin } from "../plugin";

const input: PipelinePromoteInput = {
  pipeline: "shop",
  stages: [
    { name: "staging", environment: { name: "staging" } },
    { name: "prod", environment: { name: "prod", url: "https://shop.example" } },
  ],
  bin: "npx --no-install plywood",
};

const yaml = (i: PipelinePromoteInput) => generateGithubPipelinePromote(i)[0]!.yaml;

describe("github pipeline promote", () => {
  test("golden", async () => {
    await expect(yaml(input)).toMatchFileSnapshot("./__golden__/pipeline-promote.github.yml");
  });

  test("file name and one job per stage", () => {
    const files = generateGithubPipelinePromote(input);
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
    expect(out).toContain("environment:");
    expect(out).toContain("https://shop.example");
  });

  test("refuses no stages and a bad name", () => {
    expect(() => yaml({ ...input, stages: [] })).toThrow(/no stages/);
    expect(() => yaml({ ...input, stages: [{ name: "Prod" }] })).toThrow(/not a valid name/);
  });

  test("the plugin exposes it", () => {
    expect(githubPlugin.generatePipelinePromote!(input)).toHaveLength(1);
  });
});
