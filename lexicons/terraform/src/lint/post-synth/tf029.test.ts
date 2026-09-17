import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import type { PostSynthContext } from "@intentius/chant/lint/post-synth";
import { tf029 } from "./tf029";
import { LIVE_TYPE, parseTerraformRootDir } from "../../hcl/parse";

const fixtures = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "TF029");

async function ctxFor(
  fixture: string,
  opts: { binary?: string; configEstate?: string } = {},
  root = "estate",
): Promise<PostSynthContext> {
  const entities = await parseTerraformRootDir(join(fixtures, fixture), root, undefined, {
    binary: opts.binary ?? "choudoufu",
    ...(opts.configEstate !== undefined ? { configEstate: opts.configEstate } : {}),
  });
  return { outputs: new Map(), entities } as unknown as PostSynthContext;
}

describe("TF029: an estate named twice", () => {
  test("fires when the root declares an estate in HCL and chant.config names another", async () => {
    const diags = tf029.check(await ctxFor("declared", { configEstate: "named-in-config" }));
    expect(diags).toHaveLength(1);
    expect(diags[0].checkId).toBe("TF029");
    // Both values, so a reader can see which one is being ignored without
    // opening two files.
    expect(diags[0].message).toContain("named-in-config");
    expect(diags[0].message).toContain("declared-in-hcl");
  });

  test("fires even when the two agree, and says why that is still worth fixing", async () => {
    const diags = tf029.check(await ctxFor("declared", { configEstate: "declared-in-hcl" }));
    expect(diags).toHaveLength(1);
    expect(diags[0].message).toContain("same estate today");
    expect(diags[0].message).toContain("silently ignored");
  });

  // #2479's whole feature is a root that names its estate in chant.config
  // instead of in HCL, so a rule that fired on that would refuse the thing it
  // shipped alongside.
  //
  // Stated precisely, because the obvious version of this test proves
  // nothing: a root with no `live` block produces no Terraform::Live entity
  // at all, so TF029's loop never reaches it and the assertion below would
  // pass against any implementation, including one with no guard. The
  // absence is asserted directly for that reason, and the guard itself is
  // proven by "stays silent on a stock root" above, which DOES produce a
  // Live entity and does fail when the guard is removed.
  test("a root that names its estate ONLY in chant.config has no Live entity to fire on", async () => {
    const ctx = await ctxFor("no-declaration", { configEstate: "app-staging" });
    const live = [...ctx.entities.values()].filter((e) => e.entityType === LIVE_TYPE);
    expect(live, "the fixture must declare no estate, or this test proves nothing").toHaveLength(0);
    expect(tf029.check(ctx)).toHaveLength(0);
  });

  test("stays silent on an ordinary root that declares its estate only in HCL", async () => {
    const diags = tf029.check(await ctxFor("declared"));
    expect(diags).toHaveLength(0);
  });

  test("stays silent on a stock root, which has no estate either way", async () => {
    const diags = tf029.check(await ctxFor("declared", { binary: "tofu", configEstate: "app-staging" }));
    expect(diags).toHaveLength(0);
  });

  test("reports a root once rather than once per entity in it", async () => {
    const diags = tf029.check(await ctxFor("declared", { configEstate: "named-in-config" }));
    expect(diags).toHaveLength(1);
  });
});
