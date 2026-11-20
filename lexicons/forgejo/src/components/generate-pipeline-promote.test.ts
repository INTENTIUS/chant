import { describe, expect, test } from "vitest";
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
