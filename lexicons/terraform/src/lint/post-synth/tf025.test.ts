import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import type { PostSynthContext } from "@intentius/chant/lint/post-synth";
import { tf025 } from "./tf025";
import { parseTerraformRootDir, type TerraformRootModeOptions } from "../../hcl/parse";

const fixtures = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "TF025");

async function ctxFor(
  fixture: string,
  modeOptions: TerraformRootModeOptions = { binary: "choudoufu" },
  root = "estate",
): Promise<PostSynthContext> {
  const entities = await parseTerraformRootDir(join(fixtures, fixture), root, undefined, modeOptions);
  return { outputs: new Map(), entities } as unknown as PostSynthContext;
}

describe("TF025: live root references a non-default terraform.workspace", () => {
  test("flags a `${terraform.workspace}` reference in a live root's HCL", async () => {
    const diags = tf025.check(await ctxFor("live-with-workspace-ref"));
    expect(diags).toHaveLength(1);
    expect(diags[0].checkId).toBe("TF025");
    expect(diags[0].message).toContain("terraform.workspace");
  });

  test("passes a live root with no reference and no configured workspace", async () => {
    expect(tf025.check(await ctxFor("live-clean"))).toHaveLength(0);
  });

  test("flags a live root whose terraform.roots entry configures a non-default workspace", async () => {
    const diags = tf025.check(await ctxFor("live-clean", { binary: "choudoufu", workspace: "prod" }));
    expect(diags).toHaveLength(1);
    expect(diags[0].message).toContain('workspace "prod"');
  });

  test("a workspace of \"default\" is not flagged", async () => {
    const diags = tf025.check(await ctxFor("live-clean", { binary: "choudoufu", workspace: "default" }));
    expect(diags).toHaveLength(0);
  });

  test("does not fire on a stock root (no estate takes effect under a non-choudoufu binary)", async () => {
    const diags = tf025.check(await ctxFor("live-with-workspace-ref", { binary: "terraform", workspace: "prod" }));
    expect(diags).toHaveLength(0);
  });
});
