import { describe, expect, test } from "vitest";
import {
  MODULE_CATALOG_SOURCE,
  exactModuleVersion,
  moduleCompatibility,
  registryModuleAddress,
  staticRows,
} from "./index";
import { renderStaticTier } from "./refresh-cli";
import { parseModuleCompat } from "./types";
import { SOURCE_COMMIT, STATIC_MEASUREMENT } from "./static-tier";

describe("known-module catalog (chant#4560)", () => {
  test("vendors the static tier only, with its source commit", () => {
    expect(MODULE_CATALOG_SOURCE.path).toBe("live/module-compat.json");
    expect(MODULE_CATALOG_SOURCE.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(staticRows.length).toBeGreaterThan(0);
    expect(staticRows.every((r) => r.tier === "static")).toBe(true);
  });

  test("every vendored row passes the refresh check", () => {
    expect(() =>
      parseModuleCompat({ schema: 1, static_measurement: STATIC_MEASUREMENT, static: [...staticRows] }),
    ).not.toThrow();
  });

  test("the vendored file is what the refresh script writes", () => {
    const rendered = renderStaticTier(SOURCE_COMMIT, STATIC_MEASUREMENT, staticRows);
    expect(rendered).toContain(`at commit\n// ${SOURCE_COMMIT}`);
    expect(rendered).toContain("static tier only");
  });

  test("refuses a row whose verdict disagrees with its refusals", () => {
    const row = { ...staticRows[0], verdict: "refused" as const, refusals: [] };
    expect(() => parseModuleCompat({ schema: 1, static_measurement: STATIC_MEASUREMENT, static: [row] })).toThrow(
      /refused with 0 refusals/,
    );
  });

  test.each([
    ["terraform-aws-modules/vpc/aws", "terraform-aws-modules/vpc/aws"],
    ["registry.terraform.io/terraform-aws-modules/vpc/aws", "terraform-aws-modules/vpc/aws"],
    ["terraform-aws-modules/iam/aws//modules/iam-role", "terraform-aws-modules/iam/aws"],
    ["./modules/vpc", undefined],
    ["git::https://example.com/vpc.git?ref=v1", undefined],
  ])("registryModuleAddress(%s)", (source, want) => {
    expect(registryModuleAddress(source)).toBe(want);
  });

  test.each([
    ["1.4.0", "1.4.0"],
    ["= 1.4.0", "1.4.0"],
    ["v1.4.0", "1.4.0"],
    ["~> 1.4", undefined],
  ])("exactModuleVersion(%s)", (version, want) => {
    expect(exactModuleVersion(version)).toBe(want);
  });

  test("a clear version", () => {
    expect(moduleCompatibility("terraform-aws-modules/sqs/aws", "5.2.2")).toMatchObject({
      tier: "static",
      status: "clear",
      examples: 1,
      clearExamples: 1,
      refusedExamples: 0,
      refusals: [],
    });
  });

  test("a refused version sums sites per refusal ID and lists its examples", () => {
    const c = moduleCompatibility("terraform-aws-modules/eks/aws", "= 21.29.0")!;
    expect(c.status).toBe("refused");
    expect(c.refusedExamples).toBe(c.examples);
    expect(c.refusals.length).toBeGreaterThan(0);
    for (const r of c.refusals) {
      expect(r.sites).toBeGreaterThan(0);
      expect(r.examples.length).toBeGreaterThan(0);
      expect(r.docsUrl).toMatch(/LIMITATIONS\.md#/);
    }
  });

  test("unknown module and unknown version", () => {
    expect(moduleCompatibility("cloudposse/label/null", "0.25.0")?.status).toBe("unknown-module");
    const v = moduleCompatibility("terraform-aws-modules/vpc/aws", "5.0.0")!;
    expect(v.status).toBe("unknown-version");
    expect(v.measuredVersions).toContain("6.6.1");
  });

  test("a range or a non-registry source has no answer", () => {
    expect(moduleCompatibility("terraform-aws-modules/vpc/aws", "~> 6.0")).toBeUndefined();
    expect(moduleCompatibility("./modules/vpc", "1.0.0")).toBeUndefined();
  });
});
