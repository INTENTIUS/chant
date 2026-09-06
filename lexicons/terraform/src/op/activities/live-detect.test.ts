import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { detectLiveEstate, detectLivePolicyVerbs } from "./live-detect";

const dirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "chant-tf-live-detect-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("detectLiveEstate (#2103)", () => {
  test("reads the estate from an estate.chdf.hcl sidecar", () => {
    const dir = tempDir();
    writeFileSync(join(dir, "estate.chdf.hcl"), 'estate = "prod-networking"\n');
    writeFileSync(join(dir, "main.tf"), 'resource "null_resource" "x" {}\n');
    expect(detectLiveEstate(dir)).toBe("prod-networking");
  });

  test("reads the estate from a live block nested in a terraform block", () => {
    const dir = tempDir();
    writeFileSync(
      dir + "/main.tf",
      [
        "terraform {",
        "  required_version = \">= 1.5.0\"",
        "  live {",
        '    estate = "fixture-estate"',
        "  }",
        "}",
        "",
        'resource "null_resource" "x" {}',
        "",
      ].join("\n"),
    );
    expect(detectLiveEstate(dir)).toBe("fixture-estate");
  });

  test("ignores an unrelated nested block with its own braces", () => {
    const dir = tempDir();
    writeFileSync(
      join(dir, "main.tf"),
      [
        "terraform {",
        "  required_providers {",
        '    aws = { source = "hashicorp/aws" }',
        "  }",
        "  live {",
        '    estate = "still-found"',
        "    record_store \"local\" {",
        '      path = ".tofu-records"',
        "    }",
        "  }",
        "}",
        "",
      ].join("\n"),
    );
    expect(detectLiveEstate(dir)).toBe("still-found");
  });

  test("undefined when neither form is present", () => {
    const dir = tempDir();
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "main.tf"), 'resource "null_resource" "x" {}\n');
    expect(detectLiveEstate(dir)).toBeUndefined();
  });

  test("undefined for a directory that does not exist", () => {
    expect(detectLiveEstate(join(tmpdir(), "chant-tf-live-detect-does-not-exist"))).toBeUndefined();
  });

  test("the sidecar wins when both forms are present", () => {
    const dir = tempDir();
    writeFileSync(join(dir, "estate.chdf.hcl"), 'estate = "from-sidecar"\n');
    writeFileSync(
      join(dir, "main.tf"),
      ["terraform {", "  live {", '    estate = "from-block"', "  }", "}", ""].join("\n"),
    );
    expect(detectLiveEstate(dir)).toBe("from-sidecar");
  });
});

describe("detectLivePolicyVerbs (#2106)", () => {
  test("reads undeclared_tagged and undeclared_untagged out of a nested policy block", () => {
    const dir = tempDir();
    writeFileSync(
      join(dir, "main.tf"),
      [
        "terraform {",
        "  live {",
        '    estate = "fixture-estate"',
        "    policy {",
        '      undeclared_tagged   = "keep"',
        '      undeclared_untagged = "delete"',
        "      scope {",
        '        services = ["ec2"]',
        "      }",
        "    }",
        "  }",
        "}",
        "",
      ].join("\n"),
    );
    expect(detectLivePolicyVerbs(dir)).toEqual({ undeclaredTagged: "keep", undeclaredUntagged: "delete" });
  });

  test("undefined fields when the policy block sets only one of the two", () => {
    const dir = tempDir();
    writeFileSync(
      join(dir, "main.tf"),
      ["terraform {", "  live {", '    estate = "fixture-estate"', "    policy {", '      undeclared_tagged = "untag"', "    }", "  }", "}", ""].join(
        "\n",
      ),
    );
    expect(detectLivePolicyVerbs(dir)).toEqual({ undeclaredTagged: "untag", undeclaredUntagged: undefined });
  });

  test("undefined when the live block declares no policy block", () => {
    const dir = tempDir();
    writeFileSync(
      join(dir, "main.tf"),
      ["terraform {", "  live {", '    estate = "fixture-estate"', "  }", "}", ""].join("\n"),
    );
    expect(detectLivePolicyVerbs(dir)).toBeUndefined();
  });

  test("undefined when the directory declares no live block at all", () => {
    const dir = tempDir();
    writeFileSync(join(dir, "main.tf"), 'resource "null_resource" "x" {}\n');
    expect(detectLivePolicyVerbs(dir)).toBeUndefined();
  });

  test("undefined for a directory that does not exist", () => {
    expect(detectLivePolicyVerbs(join(tmpdir(), "chant-tf-live-detect-does-not-exist"))).toBeUndefined();
  });
});
