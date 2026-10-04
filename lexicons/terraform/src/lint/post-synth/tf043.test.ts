import { describe, expect, test } from "vitest";
import type { PostSynthContext } from "@intentius/chant/lint/post-synth";
import { blocksToEntities } from "../../hcl/parse";
import { loadTreeFixture } from "./fixtures/load";
import { classifyTerragruntSource } from "./terragrunt";
import { tf043 } from "./tf043";

async function withSource(source: string): Promise<PostSynthContext> {
  const hcl = `terraform {\n  source = ${JSON.stringify(source)}\n}\n`;
  const entities = await blocksToEntities([{ name: "terragrunt.hcl", source: hcl }], "unit");
  return { outputs: new Map(), entities } as unknown as PostSynthContext;
}

describe("TF043: Terragrunt terraform.source names no version", () => {
  test.each([
    ["positive-git", "?ref="],
    ["positive-tfr", "?version="],
    ["positive-oci", "?digest="],
  ])("flags the %s fixture", async (name, fix) => {
    const diags = tf043.check(await loadTreeFixture("TF043", name));
    expect(diags).toHaveLength(1);
    expect(diags[0]).toMatchObject({ checkId: "TF043", severity: "warning", entity: "TF043/terragrunt.terraform", lexicon: "terraform" });
    expect(diags[0].message).toContain(fix);
  });

  test("a pinned git source and an interpolated source pass", async () => {
    expect(tf043.check(await loadTreeFixture("TF043", "negative"))).toEqual([]);
    expect(tf043.check(await loadTreeFixture("TF043", "negative-other"))).toEqual([]);
  });

  test.each([
    "github.com/example/modules//vpc",
    "git@github.com:example/modules.git//vpc",
    "git::ssh://git@example.com/org/modules.git",
    "tfr://registry.example.com/terraform-aws-modules/vpc/aws",
    "tfr:///terraform-aws-modules/vpc/aws?version=",
    "oci://registry.example.com:5000/org/mod",
  ])("flags %s", async (source) => {
    expect(tf043.check(await withSource(source))).toHaveLength(1);
  });

  test.each([
    "github.com/example/modules//vpc?ref=v1.0.0",
    "git::https://example.com/org/modules.git//vpc?ref=0123456789abcdef0123456789abcdef01234567",
    "tfr:///terraform-aws-modules/vpc/aws?version=5.1.0",
    "tfr:///terraform-aws-modules/vpc/aws//modules/x?version=5.1.0",
    "oci://registry.example.com/org/mod?tag=1.4.0",
    "oci://registry.example.com/org/mod@sha256:abc123",
    "../modules/vpc",
    "/abs/modules/vpc",
    "${local.base}//vpc",
    "https://example.com/modules.zip",
  ])("passes %s", async (source) => {
    expect(tf043.check(await withSource(source))).toEqual([]);
  });

  test("classification", () => {
    expect(classifyTerragruntSource("tfr:///a/b/c?version=1.0.0")).toEqual({ kind: "tfr", pinned: true });
    expect(classifyTerragruntSource("./x")).toEqual({ kind: "local" });
  });

  test("check metadata", () => {
    expect(tf043.id).toBe("TF043");
  });
});
