/**
 * The sources a root uses (chant#3924): module calls and provider addresses
 * down the local tree, implied providers, a Terragrunt unit's source, the
 * normal forms, and the local calls that cannot be followed.
 */
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { usedSources } from "./used-sources";

const FIX = join(import.meta.dirname, "__fixtures__", "used-sources");
const ROOT = join(FIX, "root");

describe("usedSources", () => {
  test("lists the root's and its local modules' sources with their block paths", async () => {
    const { used } = await usedSources(ROOT);
    const rows = used.map((u) => [u.kind, u.block, u.source, u.normal]);
    expect(rows).toEqual(
      expect.arrayContaining([
        ["provider", "required_providers.aws", "hashicorp/aws", "registry.terraform.io/hashicorp/aws"],
        ["module", "module.vpc", "terraform-aws-modules/vpc/aws", "registry.terraform.io/terraform-aws-modules/vpc/aws"],
        ["module", "module.net", "./modules/net", "./modules/net"],
        ["provider", "provider.random", "hashicorp/random", "registry.terraform.io/hashicorp/random"],
        ["provider", "provider.google", "hashicorp/google", "registry.terraform.io/hashicorp/google"],
        ["module", "module.net > module.sg", "git::https://git.acme.dev/sg.git?ref=v1.0.0", "git::https://git.acme.dev/sg.git"],
        ["provider", "module.net > required_providers.thing", "Registry.Acme.dev/acme/thing", "registry.acme.dev/acme/thing"],
        ["provider", "module.net > provider.aws", "hashicorp/aws", "registry.terraform.io/hashicorp/aws"],
      ]),
    );
  });

  test("names the file each source is written in, relative to the project", async () => {
    const { used } = await usedSources(ROOT);
    expect(used.find((u) => u.block === "module.net > module.sg")!.file).toBe("modules/net/main.tf");
    expect(used.find((u) => u.block === "module.net > required_providers.thing")!.file).toBe("modules/net/versions.tf.json");
    expect(used.find((u) => u.block === "provider.google")!.file).toBe("extra.tofu");
  });

  test("says what implies a provider, and never implies the binary's own", async () => {
    const { used } = await usedSources(ROOT);
    expect(used.find((u) => u.block === "provider.random")!.implied).toBe('resource "random_id" "x"');
    expect(used.find((u) => u.block === "module.net > provider.aws")!.implied).toBe('resource "aws_vpc" "v"');
    expect(used.some((u) => u.block.endsWith("provider.terraform"))).toBe(false);
    expect(used.some((u) => u.block === "provider.aws")).toBe(false);
  });

  test("names local calls it cannot follow and stops at a cycle", async () => {
    const { used, unread } = await usedSources(ROOT);
    expect(unread.map((u) => [u.block, u.source])).toEqual([
      ["module.gone", "./modules/missing"],
      ["module.outside", "../../outside"],
    ]);
    expect(unread[0]!.why).toContain("does not exist");
    expect(unread[1]!.why).toContain("outside the project");
    expect(used.filter((u) => u.block.startsWith("module.net > module.back > "))).toEqual([]);
  });

  test("reads only the root with followLocal off", async () => {
    const { used, unread } = await usedSources(ROOT, { followLocal: false });
    expect(used.some((u) => u.block.startsWith("module.net > "))).toBe(false);
    expect(unread).toEqual([]);
  });

  test("leaves .tofu files out for terraform, and uses OpenTofu's registry for tofu", async () => {
    const tf = await usedSources(ROOT, { binary: "terraform" });
    expect(tf.used.some((u) => u.block === "provider.google")).toBe(false);
    const tofu = await usedSources(ROOT, { binary: "tofu" });
    expect(tofu.used.find((u) => u.block === "provider.google")!.normal).toBe("registry.opentofu.org/hashicorp/google");
    expect(tofu.used.find((u) => u.block === "module.vpc")!.normal).toBe("registry.opentofu.org/terraform-aws-modules/vpc/aws");
  });

  test("reads a Terragrunt unit's terraform source", async () => {
    const { used } = await usedSources(join(FIX, "unit"), { project: FIX });
    expect(used).toEqual([{ kind: "module", file: "unit/terragrunt.hcl", block: "terraform", source: "tfr:///acme/vpc/aws?version=1.0.0", normal: "registry.terraform.io/acme/vpc/aws" }]);
  });
});
