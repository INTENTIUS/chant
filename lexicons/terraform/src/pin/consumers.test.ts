/**
 * The consumer scan (chant#4599): registry, git ref and OCI tag pins, a
 * constraint left unpinned, a Terragrunt unit's `terraform { source }`, and
 * local calls left out, all read from source files.
 */
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { isLocalSource, moduleConsumers, normalizeModuleSource } from "./consumers";

const REPO = join(import.meta.dirname, "__fixtures__", "consumers");

describe("moduleConsumers", () => {
  test("lists every published module call in the roots, sorted", async () => {
    const calls = await moduleConsumers(REPO, ["live/prod", "live/dev", "units/vpc"]);
    expect(calls.map((c) => [c.root, c.address, c.module, c.pin])).toEqual([
      ["live/dev", "module.vpc", "registry.acme.dev/acme/vpc/aws", "v2.0.0"],
      ["live/prod", "module.cache", "oci://registry.acme.dev/modules/cache", "3.1.0"],
      ["live/prod", "module.eks", "registry.terraform.io/acme/eks/aws", null],
      ["live/prod", "module.net", "git::https://git.acme.dev/acme/net.git", "v1.2.0"],
      ["live/prod", "module.vpc", "registry.acme.dev/acme/vpc/aws", "1.0.0"],
      ["units/vpc", "terragrunt.terraform", "registry.acme.dev/acme/vpc/aws", "1.1.0"],
    ]);
  });

  test("keeps where each pin sits and why a call has none", async () => {
    const calls = await moduleConsumers(REPO, ["live/prod", "units/vpc"]);
    const by = (a: string, root = "live/prod") => calls.find((c) => c.address === a && c.root === root)!;
    expect(by("module.vpc")).toMatchObject({ kind: "terraform", file: "live/prod/main.tf", at: "version", source: "registry.acme.dev/acme/vpc/aws" });
    expect(by("module.net")).toMatchObject({ at: "source", param: "ref" });
    expect(by("module.cache")).toMatchObject({ at: "source", param: "tag" });
    expect(by("module.eks").unpinned).toContain("constraint");
    expect(by("terragrunt.terraform", "units/vpc")).toMatchObject({ kind: "terragrunt", file: "units/vpc/terragrunt.hcl", at: "source", param: "version" });
  });

  test("leaves local calls out", async () => {
    const calls = await moduleConsumers(REPO, ["live/prod"]);
    expect(calls.find((c) => c.address === "module.local")).toBeUndefined();
    expect(isLocalSource("./modules/local")).toBe(true);
    expect(isLocalSource("../shared")).toBe(true);
    expect(isLocalSource("acme/vpc/aws")).toBe(false);
  });
});

describe("normalizeModuleSource", () => {
  test.each([
    ["acme/vpc/aws", "registry.terraform.io/acme/vpc/aws"],
    ["acme/vpc/aws//modules/x", "registry.terraform.io/acme/vpc/aws//modules/x"],
    ["Registry.Acme.dev/acme/vpc/aws", "registry.acme.dev/acme/vpc/aws"],
    ["tfr:///terraform-aws-modules/vpc/aws", "registry.terraform.io/terraform-aws-modules/vpc/aws"],
    ["tfr://registry.acme.dev/acme/vpc/aws", "registry.acme.dev/acme/vpc/aws"],
    ["github.com/acme/vpc", "github.com/acme/vpc"],
    ["git::https://git.acme.dev/acme/net.git", "git::https://git.acme.dev/acme/net.git"],
    ["oci://registry.acme.dev/modules/cache", "oci://registry.acme.dev/modules/cache"],
  ])("%s is %s", (from, to) => {
    expect(normalizeModuleSource(from)).toBe(to);
  });
});
