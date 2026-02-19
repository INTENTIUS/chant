import { describe, test, expect } from "bun:test";
import {
  validateManifest,
  validateRegistry,
  LexiconManifestSchema,
  IntrinsicDefSchema,
  LexiconEntrySchema,
} from "./lexicon-schema";

// ---------------------------------------------------------------------------
// validateManifest
// ---------------------------------------------------------------------------

describe("validateManifest (Zod)", () => {
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

  test("optional fields can be omitted", () => {
    const m = validateManifest({ name: "gcp", version: "2.0.0" });
    expect(m.chantVersion).toBeUndefined();
    expect(m.namespace).toBeUndefined();
    expect(m.intrinsics).toBeUndefined();
    expect(m.pseudoParameters).toBeUndefined();
  });

  test("throws on empty data (null/undefined)", () => {
    expect(() => validateManifest(null)).toThrow("empty");
    expect(() => validateManifest(undefined)).toThrow("empty");
  });

  test("throws on invalid JSON string", () => {
    expect(() => validateManifest("{bad json")).toThrow("invalid JSON");
  });

  test("throws on non-object types", () => {
    expect(() => validateManifest(42)).toThrow("must be a JSON object");
    expect(() => validateManifest([])).toThrow("must be a JSON object");
    expect(() => validateManifest(true)).toThrow("must be a JSON object");
  });

  test("throws on missing name", () => {
    expect(() => validateManifest({ version: "1.0.0" })).toThrow();
  });

  test("throws on empty name", () => {
    expect(() => validateManifest({ name: "", version: "1.0.0" })).toThrow("name");
  });

  test("throws on missing version", () => {
    expect(() => validateManifest({ name: "testdom" })).toThrow();
  });

  test("throws on invalid semver version", () => {
    expect(() => validateManifest({ name: "testdom", version: "not-a-version" })).toThrow("version");
  });

  test("accepts prerelease and build metadata in version", () => {
    const m = validateManifest({ name: "testdom", version: "1.0.0-alpha.1" });
    expect(m.version).toBe("1.0.0-alpha.1");

    const m2 = validateManifest({ name: "testdom", version: "1.0.0+build.42" });
    expect(m2.version).toBe("1.0.0+build.42");
  });

  test("rejects intrinsic with empty name", () => {
    expect(() =>
      validateManifest({
        name: "testdom",
        version: "1.0.0",
        intrinsics: [{ name: "" }],
      }),
    ).toThrow("name");
  });

  test("error path includes field location for nested intrinsic error", () => {
    try {
      validateManifest({
        name: "testdom",
        version: "1.0.0",
        intrinsics: [{ name: "" }],
      });
      expect(true).toBe(false); // should not reach
    } catch (err: unknown) {
      const msg = (err as Error).message;
      expect(msg).toContain("intrinsics");
    }
  });
});

// ---------------------------------------------------------------------------
// IntrinsicDefSchema direct
// ---------------------------------------------------------------------------

describe("IntrinsicDefSchema", () => {
  test("valid intrinsic passes", () => {
    const result = IntrinsicDefSchema.safeParse({
      name: "Ref",
      description: "Reference function",
      outputKey: "Ref",
      isTag: false,
    });
    expect(result.success).toBe(true);
  });

  test("rejects empty name", () => {
    const result = IntrinsicDefSchema.safeParse({ name: "" });
    expect(result.success).toBe(false);
  });

  test("rejects missing name", () => {
    const result = IntrinsicDefSchema.safeParse({ description: "no name" });
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// LexiconEntrySchema direct
// ---------------------------------------------------------------------------

describe("LexiconEntrySchema", () => {
  test("valid resource entry", () => {
    const result = LexiconEntrySchema.safeParse({
      resourceType: "TestDom::Storage::Bucket",
      kind: "resource",
      lexicon: "testdom",
      attrs: { bucketArn: "BucketArn" },
      createOnly: ["/properties/BucketName"],
    });
    expect(result.success).toBe(true);
  });

  test("valid property entry (minimal)", () => {
    const result = LexiconEntrySchema.safeParse({
      resourceType: "TestDom::Storage::Bucket.LifecycleRule",
      kind: "property",
      lexicon: "testdom",
    });
    expect(result.success).toBe(true);
  });

  test("rejects invalid kind", () => {
    const result = LexiconEntrySchema.safeParse({
      resourceType: "Foo",
      kind: "unknown",
      lexicon: "testdom",
    });
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// validateRegistry
// ---------------------------------------------------------------------------

describe("validateRegistry", () => {
  test("parses valid registry JSON", () => {
    const registry = validateRegistry(
      JSON.stringify({
        S3Bucket: {
          resourceType: "TestDom::Storage::Bucket",
          kind: "resource",
          lexicon: "testdom",
        },
        LambdaFunction: {
          resourceType: "TestDom::Compute::Function",
          kind: "resource",
          lexicon: "testdom",
          runtimeDeprecations: { "nodejs14.x": "deprecated" },
        },
      }),
    );
    expect(Object.keys(registry)).toHaveLength(2);
    expect(registry.S3Bucket.kind).toBe("resource");
    expect(registry.LambdaFunction.runtimeDeprecations?.["nodejs14.x"]).toBe("deprecated");
  });

  test("throws on invalid JSON", () => {
    expect(() => validateRegistry("not json")).toThrow("invalid JSON");
  });

  test("throws on malformed registry entry", () => {
    expect(() =>
      validateRegistry(
        JSON.stringify({
          BadEntry: { resourceType: 123, kind: "resource", lexicon: "testdom" },
        }),
      ),
    ).toThrow();
  });

  test("throws on registry with invalid kind enum", () => {
    expect(() =>
      validateRegistry(
        JSON.stringify({
          BadEntry: { resourceType: "Foo", kind: "module", lexicon: "testdom" },
        }),
      ),
    ).toThrow();
  });

  test("throws on non-object registry value", () => {
    expect(() => validateRegistry(JSON.stringify({ entry: "not an object" }))).toThrow();
  });

  test("error message includes path for nested issues", () => {
    try {
      validateRegistry(
        JSON.stringify({
          MyEntry: { resourceType: "Foo", kind: "bad", lexicon: "testdom" },
        }),
      );
      expect(true).toBe(false);
    } catch (err: unknown) {
      const msg = (err as Error).message;
      // Should include the key or path info
      expect(msg).toContain("registry");
    }
  });
});
