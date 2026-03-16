import { describe, test, expect } from "bun:test";
import { createPostSynthContext } from "@intentius/chant-test-utils";
import { waw022, checkLambdaVpc } from "./waw022";

function makeCtx(template: object) {
  return createPostSynthContext({ aws: template });
}

describe("WAW022: Lambda Not in VPC", () => {
  test("check metadata", () => {
    expect(waw022.id).toBe("WAW022");
    expect(waw022.description).toContain("VPC");
  });

  test("flags Lambda without VpcConfig", () => {
    const ctx = makeCtx({
      Resources: {
        MyFunc: {
          Type: "AWS::Lambda::Function",
          Properties: { FunctionName: "test", Runtime: "nodejs20.x", Handler: "index.handler" },
        },
      },
    });
    const diags = checkLambdaVpc(ctx);
    expect(diags).toHaveLength(1);
    expect(diags[0].checkId).toBe("WAW022");
    expect(diags[0].severity).toBe("warning");
  });

  test("no diagnostic when VpcConfig is present", () => {
    const ctx = makeCtx({
      Resources: {
        MyFunc: {
          Type: "AWS::Lambda::Function",
          Properties: {
            VpcConfig: { SubnetIds: ["subnet-123"], SecurityGroupIds: ["sg-123"] },
          },
        },
      },
    });
    const diags = checkLambdaVpc(ctx);
    expect(diags).toHaveLength(0);
  });

  test("no diagnostic for non-Lambda resources", () => {
    const ctx = makeCtx({
      Resources: {
        MyBucket: { Type: "AWS::S3::Bucket", Properties: {} },
      },
    });
    const diags = checkLambdaVpc(ctx);
    expect(diags).toHaveLength(0);
  });
});
