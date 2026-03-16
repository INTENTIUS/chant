import { describe, test, expect } from "bun:test";
import { createPostSynthContext } from "@intentius/chant-test-utils";
import { waw020, checkIamWildcardAction } from "./waw020";

function makeCtx(template: object) {
  return createPostSynthContext({ aws: template });
}

describe("WAW020: IAM Wildcard Action", () => {
  test("check metadata", () => {
    expect(waw020.id).toBe("WAW020");
    expect(waw020.description).toContain("wildcard");
  });

  test("flags IAM::Policy with Action: '*'", () => {
    const ctx = makeCtx({
      Resources: {
        MyPolicy: {
          Type: "AWS::IAM::Policy",
          Properties: {
            PolicyDocument: {
              Statement: [{ Effect: "Allow", Action: "*", Resource: "*" }],
            },
          },
        },
      },
    });
    const diags = checkIamWildcardAction(ctx);
    expect(diags).toHaveLength(1);
    expect(diags[0].checkId).toBe("WAW020");
    expect(diags[0].severity).toBe("warning");
  });

  test("flags IAM::Role with wildcard in inline Policies", () => {
    const ctx = makeCtx({
      Resources: {
        MyRole: {
          Type: "AWS::IAM::Role",
          Properties: {
            AssumeRolePolicyDocument: {
              Statement: [{ Effect: "Allow", Principal: { Service: "lambda.amazonaws.com" }, Action: "sts:AssumeRole" }],
            },
            Policies: [
              {
                PolicyName: "admin",
                PolicyDocument: {
                  Statement: [{ Effect: "Allow", Action: "*", Resource: "*" }],
                },
              },
            ],
          },
        },
      },
    });
    const diags = checkIamWildcardAction(ctx);
    expect(diags).toHaveLength(1);
  });

  test("flags wildcard in Action array", () => {
    const ctx = makeCtx({
      Resources: {
        MyPolicy: {
          Type: "AWS::IAM::ManagedPolicy",
          Properties: {
            PolicyDocument: {
              Statement: [{ Effect: "Allow", Action: ["s3:GetObject", "*"], Resource: "*" }],
            },
          },
        },
      },
    });
    const diags = checkIamWildcardAction(ctx);
    expect(diags).toHaveLength(1);
  });

  test("no diagnostic for specific actions", () => {
    const ctx = makeCtx({
      Resources: {
        MyPolicy: {
          Type: "AWS::IAM::Policy",
          Properties: {
            PolicyDocument: {
              Statement: [{ Effect: "Allow", Action: ["s3:GetObject", "s3:PutObject"], Resource: "arn:aws:s3:::my-bucket/*" }],
            },
          },
        },
      },
    });
    const diags = checkIamWildcardAction(ctx);
    expect(diags).toHaveLength(0);
  });

  test("no diagnostic for non-IAM resources", () => {
    const ctx = makeCtx({
      Resources: {
        MyBucket: {
          Type: "AWS::S3::Bucket",
          Properties: { BucketName: "test" },
        },
      },
    });
    const diags = checkIamWildcardAction(ctx);
    expect(diags).toHaveLength(0);
  });

  test("emits one diagnostic per resource even with multiple wildcard statements", () => {
    const ctx = makeCtx({
      Resources: {
        MyPolicy: {
          Type: "AWS::IAM::Policy",
          Properties: {
            PolicyDocument: {
              Statement: [
                { Effect: "Allow", Action: "*", Resource: "*" },
                { Effect: "Allow", Action: "*", Resource: "arn:aws:s3:::*" },
              ],
            },
          },
        },
      },
    });
    const diags = checkIamWildcardAction(ctx);
    expect(diags).toHaveLength(1);
  });
});
