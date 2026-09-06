import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import type { PostSynthContext } from "@intentius/chant/lint/post-synth";
import { tf026 } from "./tf026";
import { parseTerraformRootDir } from "../../hcl/parse";
import type { TerraformDeleteMode } from "../../config";

const fixtures = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "TF026");

async function ctxFor(
  fixture: string,
  opts: { binary?: string; delete?: TerraformDeleteMode } = {},
  root = "estate",
): Promise<PostSynthContext> {
  const entities = await parseTerraformRootDir(join(fixtures, fixture), root, undefined, {
    binary: opts.binary ?? "choudoufu",
    delete: opts.delete,
  });
  return { outputs: new Map(), entities } as unknown as PostSynthContext;
}

describe("TF026: delete: \"never\" onto the policy block", () => {
  test('fires when the policy block is absent (undeclared_tagged defaults to "delete")', async () => {
    const diags = tf026.check(await ctxFor("live-default", { delete: "never" }));
    expect(diags).toHaveLength(1);
    expect(diags[0].checkId).toBe("TF026");
    expect(diags[0].message).toContain("unset");
    expect(diags[0].message).toContain("undeclared_tagged");
  });

  test('fires when undeclared_tagged is explicitly "delete"', async () => {
    const diags = tf026.check(await ctxFor("live-explicit-delete", { delete: "never" }));
    expect(diags).toHaveLength(1);
    expect(diags[0].message).toContain('undeclared_tagged = "delete"');
  });

  test('passes when undeclared_tagged is "keep"', async () => {
    const diags = tf026.check(await ctxFor("live-keep", { delete: "never" }));
    expect(diags).toHaveLength(0);
  });

  test("passes when delete is not \"never\" at all", async () => {
    const diags = tf026.check(await ctxFor("live-default", { delete: "owned-only" }));
    expect(diags).toHaveLength(0);
    const diagsGated = tf026.check(await ctxFor("live-default", { delete: "gated" }));
    expect(diagsGated).toHaveLength(0);
    const diagsUnset = tf026.check(await ctxFor("live-default", {}));
    expect(diagsUnset).toHaveLength(0);
  });

  test("does not fire on a stock root even with delete: \"never\" recorded (inert off choudoufu)", async () => {
    const diags = tf026.check(await ctxFor("live-default", { binary: "terraform", delete: "never" }));
    expect(diags).toHaveLength(0);
  });
});
