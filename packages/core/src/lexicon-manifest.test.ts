import { describe, test, expect } from "bun:test";
import { validateManifest } from "./lexicon-schema";
import { checkVersionCompatibility } from "./lexicon-manifest";

describe("validateManifest", () => {
  test("parses valid manifest object", () => {
    const m = validateManifest({
      name: "testdom",
      version: "1.0.0",
      chantVersion: ">=0.1.0",
      namespace: "TST",
      intrinsics: [{ name: "Interpolate", outputKey: "Fn::Interpolate", isTag: true }],
      pseudoParameters: { StackName: "TestDom::StackName" },
    });
    expect(m.name).toBe("testdom");
    expect(m.version).toBe("1.0.0");
    expect(m.chantVersion).toBe(">=0.1.0");
    expect(m.namespace).toBe("TST");
    expect(m.intrinsics).toHaveLength(1);
    expect(m.pseudoParameters?.StackName).toBe("TestDom::StackName");
  });

  test("parses valid JSON string", () => {
    const m = validateManifest(JSON.stringify({ name: "testdom", version: "0.1.0" }));
    expect(m.name).toBe("testdom");
    expect(m.version).toBe("0.1.0");
  });

  test("optional chantVersion", () => {
    const m = validateManifest({ name: "gcp", version: "2.0.0" });
    expect(m.chantVersion).toBeUndefined();
  });

  test("throws on empty data", () => {
    expect(() => validateManifest(null)).toThrow("empty");
    expect(() => validateManifest(undefined)).toThrow("empty");
  });

  test("throws on invalid JSON string", () => {
    expect(() => validateManifest("{bad json")).toThrow("invalid JSON");
  });

  test("throws on missing name", () => {
    expect(() => validateManifest({ version: "1.0.0" })).toThrow("name");
  });

  test("throws on missing version", () => {
    expect(() => validateManifest({ name: "testdom" })).toThrow("version");
  });

  test("throws on non-object", () => {
    expect(() => validateManifest(42)).toThrow("must be a JSON object");
    expect(() => validateManifest([])).toThrow("must be a JSON object");
  });
});

describe("checkVersionCompatibility", () => {
  test(">= operator", () => {
    expect(checkVersionCompatibility(">=0.1.0", "0.1.0")).toBe(true);
    expect(checkVersionCompatibility(">=0.1.0", "0.2.0")).toBe(true);
    expect(checkVersionCompatibility(">=0.1.0", "1.0.0")).toBe(true);
    expect(checkVersionCompatibility(">=0.2.0", "0.1.0")).toBe(false);
  });

  test("<= operator", () => {
    expect(checkVersionCompatibility("<=1.0.0", "1.0.0")).toBe(true);
    expect(checkVersionCompatibility("<=1.0.0", "0.9.0")).toBe(true);
    expect(checkVersionCompatibility("<=1.0.0", "1.1.0")).toBe(false);
  });

  test("> operator", () => {
    expect(checkVersionCompatibility(">0.1.0", "0.2.0")).toBe(true);
    expect(checkVersionCompatibility(">0.1.0", "0.1.0")).toBe(false);
  });

  test("< operator", () => {
    expect(checkVersionCompatibility("<1.0.0", "0.9.0")).toBe(true);
    expect(checkVersionCompatibility("<1.0.0", "1.0.0")).toBe(false);
  });

  test("= operator and bare version (exact match)", () => {
    expect(checkVersionCompatibility("=1.0.0", "1.0.0")).toBe(true);
    expect(checkVersionCompatibility("=1.0.0", "1.0.1")).toBe(false);
    expect(checkVersionCompatibility("1.0.0", "1.0.0")).toBe(true);
    expect(checkVersionCompatibility("1.0.0", "1.0.1")).toBe(false);
  });

  test("empty range always passes", () => {
    expect(checkVersionCompatibility("", "1.0.0")).toBe(true);
    expect(checkVersionCompatibility("  ", "1.0.0")).toBe(true);
  });

  test("invalid version returns false", () => {
    expect(checkVersionCompatibility(">=abc", "1.0.0")).toBe(false);
    expect(checkVersionCompatibility(">=1.0.0", "abc")).toBe(false);
  });

  test("two-part version", () => {
    expect(checkVersionCompatibility(">=0.1", "0.1.0")).toBe(true);
  });
});
