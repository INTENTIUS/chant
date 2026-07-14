import { describe, test, expect } from "vitest";
import { createPostSynthContext } from "@intentius/chant-test-utils";
import { waw043, checkKmsKeyRotation } from "./waw043";

function makeCtx(template: object) {
  return createPostSynthContext({ aws: template });
}

describe("WAW043: KMS Key Rotation Disabled", () => {
  test("check metadata", () => {
    expect(waw043.id).toBe("WAW043");
    expect(waw043.description).toContain("rotation");
  });

  test("flags a key missing EnableKeyRotation", () => {
    const ctx = makeCtx({
      Resources: {
        MyKey: { Type: "AWS::KMS::Key", Properties: { Description: "app key" } },
      },
    });
    const diags = checkKmsKeyRotation(ctx);
    expect(diags).toHaveLength(1);
    expect(diags[0].checkId).toBe("WAW043");
    expect(diags[0].severity).toBe("warning");
  });

  test("flags a key with EnableKeyRotation: false", () => {
    const ctx = makeCtx({
      Resources: {
        MyKey: { Type: "AWS::KMS::Key", Properties: { EnableKeyRotation: false } },
      },
    });
    expect(checkKmsKeyRotation(ctx)).toHaveLength(1);
  });

  test("no diagnostic when EnableKeyRotation: true", () => {
    const ctx = makeCtx({
      Resources: {
        MyKey: { Type: "AWS::KMS::Key", Properties: { EnableKeyRotation: true } },
      },
    });
    expect(checkKmsKeyRotation(ctx)).toHaveLength(0);
  });

  test("skips asymmetric keys (non-default KeySpec) even without rotation", () => {
    const ctx = makeCtx({
      Resources: {
        MyKey: {
          Type: "AWS::KMS::Key",
          Properties: { KeySpec: "RSA_2048", KeyUsage: "SIGN_VERIFY" },
        },
      },
    });
    expect(checkKmsKeyRotation(ctx)).toHaveLength(0);
  });

  test("still flags an explicit SYMMETRIC_DEFAULT KeySpec without rotation", () => {
    const ctx = makeCtx({
      Resources: {
        MyKey: {
          Type: "AWS::KMS::Key",
          Properties: { KeySpec: "SYMMETRIC_DEFAULT" },
        },
      },
    });
    expect(checkKmsKeyRotation(ctx)).toHaveLength(1);
  });

  test("skips intrinsic value for EnableKeyRotation", () => {
    const ctx = makeCtx({
      Resources: {
        MyKey: { Type: "AWS::KMS::Key", Properties: { EnableKeyRotation: { Ref: "RotateParam" } } },
      },
    });
    expect(checkKmsKeyRotation(ctx)).toHaveLength(0);
  });

  test("no diagnostic for non-KMS resources", () => {
    const ctx = makeCtx({
      Resources: { MyBucket: { Type: "AWS::S3::Bucket", Properties: {} } },
    });
    expect(checkKmsKeyRotation(ctx)).toHaveLength(0);
  });
});
