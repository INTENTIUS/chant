/**
 * Module sources and provider addresses in one normal form (chant#3924):
 * the forms a source matches as, a provider's full address, the implied
 * provider, and the lock file's addresses.
 */
import { describe, expect, test } from "vitest";
import { impliedProvider, lockedProviders, moduleSourceForms, normalizeModuleSource, parseProviderAddress, providerAddress, providerAddressForms } from "./source-forms";

describe("moduleSourceForms", () => {
  test("drops the query and adds a hostless source at both default registries", () => {
    expect(moduleSourceForms("terraform-aws-modules/vpc/aws?ref=v1")).toEqual([
      "terraform-aws-modules/vpc/aws",
      "registry.terraform.io/terraform-aws-modules/vpc/aws",
      "registry.opentofu.org/terraform-aws-modules/vpc/aws",
    ]);
  });

  test("adds the hostless and other-registry forms of a source at a default registry", () => {
    expect(moduleSourceForms("registry.opentofu.org/acme/vpc/aws")).toEqual(["registry.opentofu.org/acme/vpc/aws", "acme/vpc/aws", "registry.terraform.io/acme/vpc/aws"]);
  });

  test("reads Terragrunt's tfr forms", () => {
    expect(moduleSourceForms("tfr:///acme/vpc/aws?version=1.0.0")).toEqual(["tfr:///acme/vpc/aws", "registry.terraform.io/acme/vpc/aws", "registry.opentofu.org/acme/vpc/aws", "acme/vpc/aws"]);
    expect(moduleSourceForms("tfr://Registry.Acme.dev/acme/vpc/aws")).toEqual(["tfr://Registry.Acme.dev/acme/vpc/aws", "registry.acme.dev/acme/vpc/aws"]);
  });

  test("keeps a private registry, git, OCI and local source to its one form", () => {
    expect(moduleSourceForms("registry.acme.dev/acme/vpc/aws")).toEqual(["registry.acme.dev/acme/vpc/aws"]);
    expect(moduleSourceForms("git::https://git.acme.dev/net.git?ref=v1")).toEqual(["git::https://git.acme.dev/net.git"]);
    expect(moduleSourceForms("oci://registry.acme.dev/modules/vpc?tag=1")).toEqual(["oci://registry.acme.dev/modules/vpc"]);
    expect(moduleSourceForms("./modules/vpc")).toEqual(["./modules/vpc"]);
    expect(moduleSourceForms("github.com/acme/vpc")).toEqual(["github.com/acme/vpc"]);
  });
});

describe("normalizeModuleSource", () => {
  test("gives the binary's registry to a hostless source and lower-cases a host", () => {
    expect(normalizeModuleSource("acme/vpc/aws")).toBe("registry.terraform.io/acme/vpc/aws");
    expect(normalizeModuleSource("acme/vpc/aws", "tofu")).toBe("registry.opentofu.org/acme/vpc/aws");
    expect(normalizeModuleSource("Registry.Acme.dev/acme/vpc/aws//sub")).toBe("registry.acme.dev/acme/vpc/aws//sub");
    expect(normalizeModuleSource("tfr:///acme/vpc/aws")).toBe("registry.terraform.io/acme/vpc/aws");
  });
});

describe("providerAddress", () => {
  test("gives the full lower-case form with the binary's default host", () => {
    expect(providerAddress("hashicorp/AWS")).toBe("registry.terraform.io/hashicorp/aws");
    expect(providerAddress("hashicorp/aws", "tofu")).toBe("registry.opentofu.org/hashicorp/aws");
    expect(providerAddress("aws")).toBe("registry.terraform.io/hashicorp/aws");
    expect(providerAddress("Registry.Acme.dev/acme/thing")).toBe("registry.acme.dev/acme/thing");
    expect(parseProviderAddress("localhost:8080/acme/thing")).toEqual({ host: "localhost:8080", namespace: "acme", type: "thing", address: "localhost:8080/acme/thing" });
  });

  test("refuses what is not an address", () => {
    expect(providerAddress("a/b/c/d")).toBeUndefined();
    expect(providerAddress("hashicorp/")).toBeUndefined();
    expect(providerAddress("bad host/acme/x")).toBeUndefined();
  });

  test("implies hashicorp/<name>, never for the binary's own provider", () => {
    expect(impliedProvider("aws")).toBe("hashicorp/aws");
    expect(impliedProvider("terraform")).toBeUndefined();
  });

  test("matches as written, hostless and at each default registry", () => {
    expect(providerAddressForms("hashicorp/aws")).toEqual(["hashicorp/aws", "registry.terraform.io/hashicorp/aws", "registry.opentofu.org/hashicorp/aws"]);
    expect(providerAddressForms("registry.terraform.io/hashicorp/aws")).toEqual(["registry.terraform.io/hashicorp/aws", "hashicorp/aws", "registry.opentofu.org/hashicorp/aws"]);
    expect(providerAddressForms("registry.acme.dev/acme/x")).toEqual(["registry.acme.dev/acme/x"]);
  });
});

describe("lockedProviders", () => {
  test("lists each provider the lock file names, once", () => {
    const lock = `# This file is maintained automatically by "terraform init".
provider "registry.terraform.io/hashicorp/aws" {
  version = "5.0.0"
  hashes = ["h1:x"]
}

provider "registry.opentofu.org/hashicorp/random" {
  version = "3.6.0"
}
`;
    expect(lockedProviders(lock)).toEqual(["registry.terraform.io/hashicorp/aws", "registry.opentofu.org/hashicorp/random"]);
    expect(lockedProviders("")).toEqual([]);
  });
});
