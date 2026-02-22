import { describe, test, expect } from "bun:test";
import { createPostSynthContext } from "@intentius/chant-test-utils";
import { waw018, checkS3PublicAccess } from "./waw018";

function makeCtx(template: object) {
  return createPostSynthContext({ aws: template });
}

describe("WAW018: S3 Public Access Not Blocked", () => {
  test("check metadata", () => {
    expect(waw018.id).toBe("WAW018");
    expect(waw018.description).toContain("public access");
  });

  test("flags bucket missing PublicAccessBlockConfiguration", () => {
    const ctx = makeCtx({
      Resources: {
        MyBucket: {
          Type: "AWS::S3::Bucket",
          Properties: { BucketName: "test" },
        },
      },
    });
    const diags = checkS3PublicAccess(ctx);
    expect(diags).toHaveLength(1);
    expect(diags[0].checkId).toBe("WAW018");
    expect(diags[0].severity).toBe("error");
    expect(diags[0].entity).toBe("MyBucket");
  });

  test("flags bucket with a flag set to false", () => {
    const ctx = makeCtx({
      Resources: {
        MyBucket: {
          Type: "AWS::S3::Bucket",
          Properties: {
            PublicAccessBlockConfiguration: {
              BlockPublicAcls: true,
              BlockPublicPolicy: false,
              IgnorePublicAcls: true,
              RestrictPublicBuckets: true,
            },
          },
        },
      },
    });
    const diags = checkS3PublicAccess(ctx);
    expect(diags).toHaveLength(1);
    expect(diags[0].message).toContain("BlockPublicPolicy");
  });

  test("no diagnostic when all flags are true", () => {
    const ctx = makeCtx({
      Resources: {
        MyBucket: {
          Type: "AWS::S3::Bucket",
          Properties: {
            PublicAccessBlockConfiguration: {
              BlockPublicAcls: true,
              BlockPublicPolicy: true,
              IgnorePublicAcls: true,
              RestrictPublicBuckets: true,
            },
          },
        },
      },
    });
    const diags = checkS3PublicAccess(ctx);
    expect(diags).toHaveLength(0);
  });

  test("no diagnostic for non-S3 resources", () => {
    const ctx = makeCtx({
      Resources: {
        MyFunc: {
          Type: "AWS::Lambda::Function",
          Properties: { FunctionName: "test" },
        },
      },
    });
    const diags = checkS3PublicAccess(ctx);
    expect(diags).toHaveLength(0);
  });

  test("skips intrinsic value in PublicAccessBlockConfiguration", () => {
    const ctx = makeCtx({
      Resources: {
        MyBucket: {
          Type: "AWS::S3::Bucket",
          Properties: {
            PublicAccessBlockConfiguration: { Ref: "PublicAccessParam" },
          },
        },
      },
    });
    const diags = checkS3PublicAccess(ctx);
    expect(diags).toHaveLength(0);
  });

  test("handles missing Properties", () => {
    const ctx = makeCtx({
      Resources: {
        MyBucket: { Type: "AWS::S3::Bucket" },
      },
    });
    const diags = checkS3PublicAccess(ctx);
    expect(diags).toHaveLength(1);
  });
});
