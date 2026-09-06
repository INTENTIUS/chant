import { describe, expect, test } from "vitest";
import { classifyModuleSource, isDefaultBranch, isPinnedRef } from "./module-source";

describe("classifyModuleSource", () => {
  test("local paths", () => {
    expect(classifyModuleSource("./modules/local").kind).toBe("local");
    expect(classifyModuleSource("../modules/local").kind).toBe("local");
  });

  test("registry addresses, three and four parts", () => {
    expect(classifyModuleSource("terraform-aws-modules/vpc/aws").kind).toBe("registry");
    expect(classifyModuleSource("app.terraform.io/example-corp/k8s-cluster/azurerm").kind).toBe("registry");
  });

  test("a github.com or bitbucket.org host is never a registry address, even with four parts", () => {
    expect(classifyModuleSource("github.com/hashicorp/example/extra").kind).not.toBe("registry");
    expect(classifyModuleSource("bitbucket.org/hashicorp/example/extra").kind).not.toBe("registry");
  });

  test("git sources: explicit force prefix, github/bitbucket shorthand, scp-style, .git suffix", () => {
    expect(classifyModuleSource("git::https://example.com/vpc.git").kind).toBe("git");
    expect(classifyModuleSource("hg::http://example.com/vpc").kind).toBe("git");
    expect(classifyModuleSource("github.com/hashicorp/example").kind).toBe("git");
    expect(classifyModuleSource("bitbucket.org/foo/bar").kind).toBe("git");
    expect(classifyModuleSource("git@github.com:org/repo.git").kind).toBe("git");
    expect(classifyModuleSource("https://example.com/vpc.git").kind).toBe("git");
    expect(classifyModuleSource("https://example.com/vpc.git?ref=main").kind).toBe("git");
  });

  test("extracts ref, falling back to rev", () => {
    expect(classifyModuleSource("git::https://example.com/vpc.git?ref=v1.2.0").ref).toBe("v1.2.0");
    expect(classifyModuleSource("git::https://example.com/vpc.git?rev=v1.2.0").ref).toBe("v1.2.0");
    expect(classifyModuleSource("git::https://example.com/vpc.git?ref=v1.2.0&rev=other").ref).toBe("v1.2.0");
    expect(classifyModuleSource("git::https://example.com/vpc.git").ref).toBeUndefined();
  });

  test("a source that parses as neither local, registry nor git is other", () => {
    expect(classifyModuleSource("s3::https://bucket.s3.amazonaws.com/vpc.zip").kind).toBe("other");
    expect(classifyModuleSource("not a valid source at all").kind).toBe("other");
  });
});

describe("isPinnedRef", () => {
  test("accepts semver-shaped tags, with or without a leading v", () => {
    expect(isPinnedRef("v1.2.0")).toBe(true);
    expect(isPinnedRef("1.2.0")).toBe(true);
    expect(isPinnedRef("v1.2.0-rc.1")).toBe(true);
  });

  test("accepts a full 40-hex commit SHA", () => {
    expect(isPinnedRef("abcdef1234567890abcdef1234567890abcdef12")).toBe(true);
  });

  test("rejects a short SHA", () => {
    expect(isPinnedRef("abcdef1")).toBe(false);
  });

  test("rejects checkov's CKV_TF_2-passing but non-semver v1.2-dev (chant is stricter)", () => {
    expect(isPinnedRef("v1.2-dev")).toBe(false);
  });

  test("rejects an arbitrary branch-shaped name", () => {
    expect(isPinnedRef("some-feature")).toBe(false);
  });
});

describe("isDefaultBranch", () => {
  test("recognizes the four known mutable branch names", () => {
    for (const b of ["main", "master", "develop", "trunk"]) expect(isDefaultBranch(b)).toBe(true);
  });

  test("does not flag an arbitrary branch name as a default branch", () => {
    expect(isDefaultBranch("some-feature")).toBe(false);
  });
});
