import { describe, test, expect } from "bun:test";
import { hashArtifact, computeIntegrity, verifyIntegrity, type ArtifactIntegrity } from "./lexicon-integrity";
import type { BundleSpec } from "./lexicon";

describe("hashArtifact", () => {
  test("returns hex string", () => {
    const hash = hashArtifact("hello world");
    expect(hash).toMatch(/^[0-9a-f]+$/);
  });

  test("is deterministic", () => {
    const a = hashArtifact("test content");
    const b = hashArtifact("test content");
    expect(a).toBe(b);
  });

  test("different inputs produce different hashes", () => {
    const a = hashArtifact("content-a");
    const b = hashArtifact("content-b");
    expect(a).not.toBe(b);
  });
});

function makeSpec(overrides?: Partial<BundleSpec>): BundleSpec {
  return {
    manifest: { name: "test", version: "1.0.0" },
    registry: '{"Bucket":{"kind":"resource","resourceType":"TestDom::Storage::Bucket","lexicon":"testdom"}}',
    typesDTS: "declare class Bucket {}",
    rules: new Map([["rule1.ts", "export const rule1 = {};"]]),
    skills: new Map([["skill1.md", "# Skill 1"]]),
    ...overrides,
  };
}

describe("computeIntegrity", () => {
  test("returns xxhash64 algorithm", () => {
    const integrity = computeIntegrity(makeSpec());
    expect(integrity.algorithm).toBe("xxhash64");
  });

  test("hashes all artifacts", () => {
    const integrity = computeIntegrity(makeSpec());
    expect(integrity.artifacts["manifest.json"]).toBeDefined();
    expect(integrity.artifacts["meta.json"]).toBeDefined();
    expect(integrity.artifacts["types/index.d.ts"]).toBeDefined();
    expect(integrity.artifacts["rules/rule1.ts"]).toBeDefined();
    expect(integrity.artifacts["skills/skill1.md"]).toBeDefined();
  });

  test("composite hash is deterministic", () => {
    const a = computeIntegrity(makeSpec());
    const b = computeIntegrity(makeSpec());
    expect(a.composite).toBe(b.composite);
  });

  test("composite changes when any artifact changes", () => {
    const original = computeIntegrity(makeSpec());
    const modified = computeIntegrity(makeSpec({ registry: '{"different": true}' }));
    expect(original.composite).not.toBe(modified.composite);
  });
});

describe("verifyIntegrity", () => {
  test("passes for matching spec", () => {
    const spec = makeSpec();
    const integrity = computeIntegrity(spec);
    const result = verifyIntegrity(spec, integrity);
    expect(result.ok).toBe(true);
    expect(result.mismatches).toHaveLength(0);
  });

  test("detects tampered artifact", () => {
    const spec = makeSpec();
    const integrity = computeIntegrity(spec);

    // Tamper with the registry
    const tampered = makeSpec({ registry: '{"tampered": true}' });
    const result = verifyIntegrity(tampered, integrity);
    expect(result.ok).toBe(false);
    expect(result.mismatches).toContain("meta.json");
  });

  test("detects extra artifacts", () => {
    const spec = makeSpec();
    const integrity = computeIntegrity(spec);

    // Add an extra rule
    const modified = makeSpec();
    modified.rules.set("extra.ts", "extra content");
    const result = verifyIntegrity(modified, integrity);
    expect(result.ok).toBe(false);
    expect(result.mismatches).toContain("rules/extra.ts");
  });
});
