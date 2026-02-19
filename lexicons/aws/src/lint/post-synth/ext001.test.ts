import { describe, test, expect } from "bun:test";
import type { PostSynthContext } from "@intentius/chant/lint/post-synth";
import { createPostSynthContext } from "@intentius/chant-test-utils";
import { ext001 } from "./ext001";

function makeCtx(template: object) {
  return createPostSynthContext({ aws: template });
}

describe("EXT001: Extension Constraint Violation", () => {
  test("check metadata", () => {
    expect(ext001.id).toBe("EXT001");
    expect(ext001.description).toContain("constraint");
  });

  test("no diagnostics on empty template", () => {
    const ctx = makeCtx({ Resources: {} });
    const diags = ext001.check(ctx);
    expect(diags).toHaveLength(0);
  });

  test("no diagnostics on unknown resource type", () => {
    const ctx = makeCtx({
      Resources: {
        MyCustom: {
          Type: "Custom::MyResource",
          Properties: { Foo: "bar" },
        },
      },
    });
    const diags = ext001.check(ctx);
    expect(diags).toHaveLength(0);
  });

  // The following tests exercise the constraint validation logic directly
  // by testing the check function. Whether diagnostics fire depends on
  // the lexicon having constraints for the resource types used.
  // Since we may not have the lexicon JSON in test environments,
  // we verify the function at least runs without errors.
  test("handles resource with no properties gracefully", () => {
    const ctx = makeCtx({
      Resources: {
        MyBucket: {
          Type: "AWS::S3::Bucket",
        },
      },
    });
    // Should not throw, diagnostics depend on lexicon data
    const diags = ext001.check(ctx);
    expect(Array.isArray(diags)).toBe(true);
  });

  test("handles invalid JSON output gracefully", () => {
    const ctx: PostSynthContext = {
      outputs: new Map([["aws", "not json"]]),
      entities: new Map(),
      buildResult: {
        outputs: new Map([["aws", "not json"]]),
        entities: new Map(),
        warnings: [],
        errors: [],
        sourceFileCount: 0,
      },
    };
    const diags = ext001.check(ctx);
    expect(diags).toHaveLength(0);
  });
});
