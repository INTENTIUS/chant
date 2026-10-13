import { describe, expect, test } from "vitest";
import type { PostSynthContext } from "@intentius/chant/lint/post-synth";
import { blocksToEntities } from "../../hcl/parse";
import { loadFixture } from "./fixtures/load";
import { tf039 } from "./tf039";
import { terraformPlugin } from "../../plugin";

async function withVersion(version: string | undefined, source = "terraform-aws-modules/vpc/aws"): Promise<PostSynthContext> {
  const hcl = `module "vpc" {\n  source = "${source}"\n${version === undefined ? "" : `  version = ${JSON.stringify(version)}\n`}}\n`;
  const entities = await blocksToEntities([{ name: "main.tf", source: hcl }], "app");
  return { outputs: new Map(), entities } as unknown as PostSynthContext;
}

describe("TF039: registry module version is a range", () => {
  test("flags the documented positive fixture", async () => {
    expect(tf039.check(await loadFixture("TF039", "positive"))).toHaveLength(1);
  });

  test.each(["~> 1.4", ">= 1.4", ">= 1.0, < 2.0", "< 2.0", "!= 1.4.0"])("flags %s", async (v) => {
    const diags = tf039.check(await withVersion(v));
    expect(diags).toHaveLength(1);
    expect(diags[0]).toMatchObject({ checkId: "TF039", severity: "warning", entity: "app/module.vpc" });
    expect(diags[0].message).toContain(v);
  });

  test.each(["1.4.0", "= 1.4.0", "=1.4.0"])("passes %s", async (v) => {
    expect(tf039.check(await withVersion(v))).toEqual([]);
  });

  test("leaves a missing version to TF004, and non-registry sources alone", async () => {
    expect(tf039.check(await withVersion(undefined))).toEqual([]);
    expect(tf039.check(await withVersion("~> 1.0", "./modules/x"))).toEqual([]);
  });

  test("is off by default: in the all preset, not in recommended", () => {
    const presets = terraformPlugin.lintPresets!();
    expect(presets.all).toContain("TF039");
    expect(presets.recommended).not.toContain("TF039");
  });
});
