import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import type { PostSynthContext } from "@intentius/chant/lint/post-synth";
import { tf027 } from "./tf027";
import { parseTerraformRootDir } from "../../hcl/parse";

const fixtures = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "TF027");

async function ctxFor(
  fixture: string,
  opts: { binary?: string } = {},
  root = "estate",
): Promise<PostSynthContext> {
  const entities = await parseTerraformRootDir(join(fixtures, fixture), root, undefined, {
    binary: opts.binary ?? "choudoufu",
  });
  return { outputs: new Map(), entities } as unknown as PostSynthContext;
}

describe('TF027: undeclared_untagged = "delete" on a live root', () => {
  test("fires on a policy block that sets it, naming the root and the setting", async () => {
    const diags = tf027.check(await ctxFor("live-untagged-delete"));
    expect(diags).toHaveLength(1);
    expect(diags[0].checkId).toBe("TF027");
    expect(diags[0].severity).toBe("error");
    expect(diags[0].lexicon).toBe("terraform");
    expect(diags[0].message).toContain('Root module "estate"');
    expect(diags[0].message).toContain('undeclared_untagged = "delete"');
  });

  test("fires even when a scope block narrows the account reconciliation", async () => {
    const diags = tf027.check(await ctxFor("live-untagged-delete-scoped"));
    expect(diags).toHaveLength(1);
    expect(diags[0].checkId).toBe("TF027");
  });

  test('passes when the quadrant is set to something else ("report")', async () => {
    expect(tf027.check(await ctxFor("live-untagged-report"))).toEqual([]);
  });

  test("passes when the root declares no policy block at all", async () => {
    expect(tf027.check(await ctxFor("live-default"))).toEqual([]);
  });

  test("does not fire on a stock root: the policy block is inert off choudoufu", async () => {
    expect(tf027.check(await ctxFor("live-untagged-delete", { binary: "terraform" }))).toEqual([]);
  });

  test("fires once per root, not once per live entity", async () => {
    const a = await parseTerraformRootDir(join(fixtures, "live-untagged-delete"), "estate", undefined, {
      binary: "choudoufu",
    });
    const b = await parseTerraformRootDir(join(fixtures, "live-untagged-delete"), "other", undefined, {
      binary: "choudoufu",
    });
    const entities = new Map([...a, ...b]);
    const diags = tf027.check({ outputs: new Map(), entities } as unknown as PostSynthContext);
    expect(diags).toHaveLength(2);
    expect(diags.map((d) => d.message.match(/Root module "([^"]+)"/)?.[1]).sort()).toEqual(["estate", "other"]);
  });
});
