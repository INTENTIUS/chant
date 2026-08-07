/**
 * Compile-time contract with the lexicon's authoring layer (#791): the
 * warden's redeclared config types and `@intentius/chant-lexicon-aws`'s must
 * stay mutually assignable. A drift on either side fails typecheck here.
 */
import { describe, expect, it } from "vitest";
import type { AwsGovernanceConfig as LexiconShape } from "@intentius/chant-lexicon-aws";
import { landingZoneConfig } from "@intentius/chant-lexicon-aws";
import type { AwsGovernanceConfig as WardenShape } from "./types.js";

// Mutual assignability, both directions, checked by tsc:
const _toWarden = (x: LexiconShape): WardenShape => x;
const _toLexicon = (x: WardenShape): LexiconShape => x;

describe("config shape contract (#791/#792)", () => {
  it("the lexicon's landingZoneConfig output loads as warden config", () => {
    const cfg: WardenShape = landingZoneConfig({ allowedRegions: ["eu-west-1"], cloudtrailBucket: "audit" });
    expect(Object.keys(cfg.ous)).toContain("Security");
    expect(cfg.auditSinks?.cloudtrail?.bucket).toBe("audit");
    expect(_toWarden).toBeTypeOf("function");
    expect(_toLexicon).toBeTypeOf("function");
  });
});
