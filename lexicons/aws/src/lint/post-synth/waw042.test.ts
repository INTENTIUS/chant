import { describe, test, expect } from "vitest";
import { createPostSynthContext } from "@intentius/chant-test-utils";
import { waw042, checkS3TlsOnlyPolicy } from "./waw042";

function makeCtx(template: object) {
  return createPostSynthContext({ aws: template });
}

const secureTransportDeny = {
  Effect: "Deny",
  Principal: "*",
  Action: "s3:*",
  Condition: { Bool: { "aws:SecureTransport": "false" } },
};

describe("WAW042: S3 Bucket Missing TLS-Only Policy", () => {
  test("check metadata", () => {
    expect(waw042.id).toBe("WAW042");
    expect(waw042.description).toContain("TLS");
  });

  test("flags a bucket with no BucketPolicy at all", () => {
    const ctx = makeCtx({
      Resources: {
        MyBucket: { Type: "AWS::S3::Bucket", Properties: {} },
      },
    });
    const diags = checkS3TlsOnlyPolicy(ctx);
    expect(diags).toHaveLength(1);
    expect(diags[0].checkId).toBe("WAW042");
    expect(diags[0].entity).toBe("MyBucket");
  });

  test("flags a bucket whose BucketPolicy has no SecureTransport deny", () => {
    const ctx = makeCtx({
      Resources: {
        MyBucket: { Type: "AWS::S3::Bucket", Properties: {} },
        MyBucketPolicy: {
          Type: "AWS::S3::BucketPolicy",
          Properties: {
            Bucket: { Ref: "MyBucket" },
            PolicyDocument: {
              Statement: [{ Effect: "Allow", Principal: "*", Action: "s3:GetObject" }],
            },
          },
        },
      },
    });
    expect(checkS3TlsOnlyPolicy(ctx)).toHaveLength(1);
  });

  test("no diagnostic when the BucketPolicy denies non-TLS requests (Ref)", () => {
    const ctx = makeCtx({
      Resources: {
        MyBucket: { Type: "AWS::S3::Bucket", Properties: {} },
        MyBucketPolicy: {
          Type: "AWS::S3::BucketPolicy",
          Properties: {
            Bucket: { Ref: "MyBucket" },
            PolicyDocument: { Statement: [secureTransportDeny] },
          },
        },
      },
    });
    expect(checkS3TlsOnlyPolicy(ctx)).toHaveLength(0);
  });

  test("no diagnostic when the BucketPolicy targets the bucket via Fn::GetAtt", () => {
    const ctx = makeCtx({
      Resources: {
        MyBucket: { Type: "AWS::S3::Bucket", Properties: {} },
        MyBucketPolicy: {
          Type: "AWS::S3::BucketPolicy",
          Properties: {
            Bucket: { "Fn::GetAtt": ["MyBucket", "Arn"] },
            PolicyDocument: { Statement: [secureTransportDeny] },
          },
        },
      },
    });
    expect(checkS3TlsOnlyPolicy(ctx)).toHaveLength(0);
  });

  test("a boolean (non-string) SecureTransport condition also satisfies the check", () => {
    const ctx = makeCtx({
      Resources: {
        MyBucket: { Type: "AWS::S3::Bucket", Properties: {} },
        MyBucketPolicy: {
          Type: "AWS::S3::BucketPolicy",
          Properties: {
            Bucket: { Ref: "MyBucket" },
            PolicyDocument: {
              Statement: [{ Effect: "Deny", Condition: { Bool: { "aws:SecureTransport": false } } }],
            },
          },
        },
      },
    });
    expect(checkS3TlsOnlyPolicy(ctx)).toHaveLength(0);
  });

  test("does not credit an Allow statement's SecureTransport condition", () => {
    const ctx = makeCtx({
      Resources: {
        MyBucket: { Type: "AWS::S3::Bucket", Properties: {} },
        MyBucketPolicy: {
          Type: "AWS::S3::BucketPolicy",
          Properties: {
            Bucket: { Ref: "MyBucket" },
            PolicyDocument: {
              Statement: [{ Effect: "Allow", Condition: { Bool: { "aws:SecureTransport": "false" } } }],
            },
          },
        },
      },
    });
    expect(checkS3TlsOnlyPolicy(ctx)).toHaveLength(1);
  });

  test("a policy covering a different bucket does not clear this one", () => {
    const ctx = makeCtx({
      Resources: {
        MyBucket: { Type: "AWS::S3::Bucket", Properties: {} },
        OtherBucket: { Type: "AWS::S3::Bucket", Properties: {} },
        OtherBucketPolicy: {
          Type: "AWS::S3::BucketPolicy",
          Properties: {
            Bucket: { Ref: "OtherBucket" },
            PolicyDocument: { Statement: [secureTransportDeny] },
          },
        },
      },
    });
    const diags = checkS3TlsOnlyPolicy(ctx);
    expect(diags).toHaveLength(1);
    expect(diags[0].entity).toBe("MyBucket");
  });
});
