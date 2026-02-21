import { describe, test, expect } from "bun:test";
import { createPostSynthContext } from "@intentius/chant-test-utils";
import { waw016, checkDeprecatedProperties } from "./waw016";

function makeCtx(template: object) {
  return createPostSynthContext({ aws: template });
}

/** Synthetic deprecated-property map — no disk dependency. */
function fakeDeprecated(): Map<string, Set<string>> {
  return new Map([
    ["AWS::S3::Bucket", new Set(["AccessControl", "ObjectLockConfiguration"])],
    ["AWS::Lambda::Function", new Set(["Code"])],
  ]);
}

describe("WAW016: Deprecated Property Usage", () => {
  test("check metadata", () => {
    expect(waw016.id).toBe("WAW016");
    expect(waw016.description).toContain("Deprecated");
  });

  test("emits warning for deprecated property", () => {
    const ctx = makeCtx({
      Resources: {
        MyBucket: {
          Type: "AWS::S3::Bucket",
          Properties: {
            AccessControl: "LogDeliveryWrite",
            BucketName: "my-bucket",
          },
        },
      },
    });
    const diags = checkDeprecatedProperties(ctx, fakeDeprecated());
    expect(diags).toHaveLength(1);
    expect(diags[0].checkId).toBe("WAW016");
    expect(diags[0].severity).toBe("warning");
    expect(diags[0].message).toContain("AccessControl");
    expect(diags[0].message).toContain("MyBucket");
    expect(diags[0].message).toContain("deprecated");
    expect(diags[0].entity).toBe("MyBucket");
    expect(diags[0].lexicon).toBe("aws");
  });

  test("emits one warning per deprecated property", () => {
    const ctx = makeCtx({
      Resources: {
        MyBucket: {
          Type: "AWS::S3::Bucket",
          Properties: {
            AccessControl: "Private",
            ObjectLockConfiguration: {},
          },
        },
      },
    });
    const diags = checkDeprecatedProperties(ctx, fakeDeprecated());
    expect(diags).toHaveLength(2);
    const props = diags.map((d) => d.message);
    expect(props.some((m) => m.includes("AccessControl"))).toBe(true);
    expect(props.some((m) => m.includes("ObjectLockConfiguration"))).toBe(true);
  });

  test("no diagnostic for non-deprecated properties", () => {
    const ctx = makeCtx({
      Resources: {
        MyBucket: {
          Type: "AWS::S3::Bucket",
          Properties: {
            BucketName: "clean-bucket",
            VersioningConfiguration: { Status: "Enabled" },
          },
        },
      },
    });
    const diags = checkDeprecatedProperties(ctx, fakeDeprecated());
    expect(diags).toHaveLength(0);
  });

  test("no diagnostic for resource type not in map", () => {
    const ctx = makeCtx({
      Resources: {
        MyRole: {
          Type: "AWS::IAM::Role",
          Properties: { RoleName: "test" },
        },
      },
    });
    const diags = checkDeprecatedProperties(ctx, fakeDeprecated());
    expect(diags).toHaveLength(0);
  });

  test("no diagnostic on empty template", () => {
    const ctx = makeCtx({ Resources: {} });
    const diags = checkDeprecatedProperties(ctx, fakeDeprecated());
    expect(diags).toHaveLength(0);
  });

  test("handles resource with no Properties", () => {
    const ctx = makeCtx({
      Resources: {
        MyBucket: { Type: "AWS::S3::Bucket" },
      },
    });
    const diags = checkDeprecatedProperties(ctx, fakeDeprecated());
    expect(diags).toHaveLength(0);
  });

  test("returns empty when deprecated map is empty", () => {
    const ctx = makeCtx({
      Resources: {
        MyBucket: {
          Type: "AWS::S3::Bucket",
          Properties: { AccessControl: "Private" },
        },
      },
    });
    const diags = checkDeprecatedProperties(ctx, new Map());
    expect(diags).toHaveLength(0);
  });

  test("flags deprecated properties across multiple resources", () => {
    const ctx = makeCtx({
      Resources: {
        Bucket: {
          Type: "AWS::S3::Bucket",
          Properties: { AccessControl: "Private" },
        },
        Func: {
          Type: "AWS::Lambda::Function",
          Properties: { Code: {} },
        },
      },
    });
    const diags = checkDeprecatedProperties(ctx, fakeDeprecated());
    expect(diags).toHaveLength(2);
    expect(diags[0].entity).toBe("Bucket");
    expect(diags[1].entity).toBe("Func");
  });
});
