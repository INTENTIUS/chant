import { describe, test, expect } from "bun:test";
import { createPostSynthContext } from "@intentius/chant-test-utils";
import { waw028, checkEbsEncryption } from "./waw028";

function makeCtx(template: object) {
  return createPostSynthContext({ aws: template });
}

describe("WAW028: EBS Volume Not Encrypted", () => {
  test("check metadata", () => {
    expect(waw028.id).toBe("WAW028");
    expect(waw028.description).toContain("encrypted");
  });

  test("flags volume without Encrypted", () => {
    const ctx = makeCtx({
      Resources: {
        MyVol: {
          Type: "AWS::EC2::Volume",
          Properties: { AvailabilityZone: "us-east-1a", Size: 100 },
        },
      },
    });
    const diags = checkEbsEncryption(ctx);
    expect(diags).toHaveLength(1);
    expect(diags[0].checkId).toBe("WAW028");
    expect(diags[0].severity).toBe("warning");
  });

  test("no diagnostic when Encrypted: true", () => {
    const ctx = makeCtx({
      Resources: {
        MyVol: {
          Type: "AWS::EC2::Volume",
          Properties: { AvailabilityZone: "us-east-1a", Encrypted: true },
        },
      },
    });
    const diags = checkEbsEncryption(ctx);
    expect(diags).toHaveLength(0);
  });

  test("flags Encrypted: false", () => {
    const ctx = makeCtx({
      Resources: {
        MyVol: {
          Type: "AWS::EC2::Volume",
          Properties: { AvailabilityZone: "us-east-1a", Encrypted: false },
        },
      },
    });
    const diags = checkEbsEncryption(ctx);
    expect(diags).toHaveLength(1);
  });

  test("skips intrinsic value for Encrypted", () => {
    const ctx = makeCtx({
      Resources: {
        MyVol: {
          Type: "AWS::EC2::Volume",
          Properties: { AvailabilityZone: "us-east-1a", Encrypted: { Ref: "EncryptParam" } },
        },
      },
    });
    const diags = checkEbsEncryption(ctx);
    expect(diags).toHaveLength(0);
  });
});
