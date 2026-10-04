import { describe, expect, test } from "vitest";
import type { PostSynthContext } from "@intentius/chant/lint/post-synth";
import { blocksToEntities } from "../../hcl/parse";
import { loadFixture } from "./fixtures/load";
import { tf038 } from "./tf038";

async function withSource(source: string): Promise<PostSynthContext> {
  const hcl = `module "m" {\n  source = ${JSON.stringify(source)}\n}\n`;
  const entities = await blocksToEntities([{ name: "main.tf", source: hcl }], "app");
  return { outputs: new Map(), entities } as unknown as PostSynthContext;
}

describe("TF038: OCI module source with no tag or digest, or a mutable tag", () => {
  test("flags the documented positive fixture", async () => {
    expect(tf038.check(await loadFixture("TF038", "positive"))).toHaveLength(1);
  });

  test("check metadata", () => {
    expect(tf038.id).toBe("TF038");
  });

  test.each([
    ["no tag or digest", "oci://example.com/org/mod"],
    ["no tag, registry host with a port", "oci://registry.example.com:5000/org/mod"],
    ["latest as a query tag", "oci://example.com/org/mod?tag=latest"],
    ["latest as a suffix tag", "oci://example.com/org/mod:latest"],
    ["no pin, with a subdirectory", "oci://example.com/org/mod//modules/vpc"],
  ])("flags %s", async (_n, source) => {
    const diags = tf038.check(await withSource(source));
    expect(diags).toHaveLength(1);
    expect(diags[0]).toMatchObject({ checkId: "TF038", severity: "warning", entity: "app/module.m", lexicon: "terraform" });
    expect(diags[0].message).toContain(source);
  });

  test.each([
    ["an exact tag", "oci://example.com/org/mod?tag=1.4.0"],
    ["an exact suffix tag", "oci://example.com/org/mod:v1.4.0"],
    ["a digest", "oci://example.com/org/mod?digest=sha256:abc123"],
    ["a suffix digest", "oci://example.com/org/mod@sha256:abc123"],
    ["a digest beside latest", "oci://example.com/org/mod:latest@sha256:abc123"],
    ["a tag on a host with a port", "oci://registry.example.com:5000/org/mod:1.4.0"],
  ])("passes %s", async (_n, source) => {
    expect(tf038.check(await withSource(source))).toEqual([]);
  });

  test("ignores a registry, git and local source", async () => {
    for (const s of ["terraform-aws-modules/vpc/aws", "git::https://example.com/vpc.git", "./modules/x"]) {
      expect(tf038.check(await withSource(s))).toEqual([]);
    }
  });
});
