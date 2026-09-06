import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import type { PostSynthContext } from "@intentius/chant/lint/post-synth";
import { tf024 } from "./tf024";
import { parseTerraformRootDir } from "../../hcl/parse";

const fixtures = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "TF024");

async function ctxFor(fixture: string, root = "estate"): Promise<PostSynthContext> {
  const entities = await parseTerraformRootDir(join(fixtures, fixture), root, undefined, { binary: "choudoufu" });
  return { outputs: new Map(), entities } as unknown as PostSynthContext;
}

describe("TF024: live root declares a backend or cloud block", () => {
  test("flags a live root with a backend block", async () => {
    const diags = tf024.check(await ctxFor("live-with-backend"));
    expect(diags).toHaveLength(1);
    expect(diags[0].checkId).toBe("TF024");
    expect(diags[0].message).toContain("backend");
    expect(diags[0].message).toContain("Both a backend and a live");
  });

  test("flags a live root with a cloud block", async () => {
    const diags = tf024.check(await ctxFor("live-with-cloud"));
    expect(diags).toHaveLength(1);
    expect(diags[0].message).toContain("cloud");
  });

  test("passes a live root with neither block", async () => {
    const diags = tf024.check(await ctxFor("live-clean"));
    expect(diags).toHaveLength(0);
  });

  test("does not fire on a stock root with a backend block (that is TF001's territory)", async () => {
    const entities = await parseTerraformRootDir(join(fixtures, "live-with-backend"), "estate", undefined, {
      binary: "terraform", // no estate takes effect: this root stays state mode
    });
    const ctx = { outputs: new Map(), entities } as unknown as PostSynthContext;
    expect(tf024.check(ctx)).toHaveLength(0);
  });
});
