import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import type { PostSynthContext } from "@intentius/chant/lint/post-synth";
import { parseTerraformRootDir } from "../../hcl/parse";
import { terraformPlugin } from "../../plugin";
import { tf047 } from "./tf047";

const fixtures = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "TF047");

async function ctxFor(fixture: string, binary: "choudoufu" | "terraform" = "choudoufu"): Promise<PostSynthContext> {
  const entities = await parseTerraformRootDir(join(fixtures, fixture), "estate", undefined, { binary });
  return { outputs: new Map(), entities } as unknown as PostSynthContext;
}

describe("TF047: live root pins a module version the catalog has no row for, or one with refusals", () => {
  test("warns on a version whose static rows are refused, with IDs, links and the tier", async () => {
    const diags = tf047.check(await ctxFor("refused"));
    expect(diags).toHaveLength(1);
    expect(diags[0]).toMatchObject({ checkId: "TF047", severity: "warning", entity: "estate/module.eks" });
    expect(diags[0].message).toContain("terraform-aws-modules/eks/aws 21.29.0");
    expect(diags[0].message).toContain("6 of 6 examples");
    expect(diags[0].message).toContain("static tier");
    expect(diags[0].message).toContain("https://github.com/INTENTIUS/choudoufu/blob/main/live/LIMITATIONS.md#");
    expect(diags[0].message).not.toMatch(/gauntlet/i);
  });

  test("is quiet when every example at the version is clear", async () => {
    expect(tf047.check(await ctxFor("clear"))).toEqual([]);
  });

  test("reports a version with no row at info, naming the measured versions", async () => {
    const diags = tf047.check(await ctxFor("unknown-version"));
    expect(diags).toHaveLength(1);
    expect(diags[0].severity).toBe("info");
    expect(diags[0].message).toContain("no row at this version");
    expect(diags[0].message).toContain("6.6.1");
  });

  test("reports a module with no row at info", async () => {
    const diags = tf047.check(await ctxFor("unknown-module"));
    expect(diags).toHaveLength(1);
    expect(diags[0].severity).toBe("info");
    expect(diags[0].message).toContain("no row for this module");
  });

  test("skips a stock root: the table measures choudoufu", async () => {
    expect(tf047.check(await ctxFor("refused", "terraform"))).toEqual([]);
  });

  test("is off by default: in the all preset, not in recommended", () => {
    const presets = terraformPlugin.lintPresets!();
    expect(presets.all).toContain("TF047");
    expect(presets.recommended).not.toContain("TF047");
  });
});
