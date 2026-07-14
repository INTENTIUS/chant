import { describe, test, expect } from "vitest";
import { createPostSynthContext } from "@intentius/chant-test-utils";
import { waw050, checkCognitoAdvancedSecurity } from "./waw050";

function makeCtx(template: object) {
  return createPostSynthContext({ aws: template });
}

describe("WAW050: Cognito Advanced Security Disabled", () => {
  test("check metadata", () => {
    expect(waw050.id).toBe("WAW050");
    expect(waw050.description).toContain("advanced security");
  });

  test("flags a pool with no UserPoolAddOns", () => {
    const ctx = makeCtx({
      Resources: { MyPool: { Type: "AWS::Cognito::UserPool", Properties: { UserPoolName: "app" } } },
    });
    const diags = checkCognitoAdvancedSecurity(ctx);
    expect(diags).toHaveLength(1);
    expect(diags[0].checkId).toBe("WAW050");
  });

  test("flags AdvancedSecurityMode: OFF", () => {
    const ctx = makeCtx({
      Resources: {
        MyPool: {
          Type: "AWS::Cognito::UserPool",
          Properties: { UserPoolAddOns: { AdvancedSecurityMode: "OFF" } },
        },
      },
    });
    expect(checkCognitoAdvancedSecurity(ctx)).toHaveLength(1);
  });

  test("no diagnostic for AUDIT mode", () => {
    const ctx = makeCtx({
      Resources: {
        MyPool: {
          Type: "AWS::Cognito::UserPool",
          Properties: { UserPoolAddOns: { AdvancedSecurityMode: "AUDIT" } },
        },
      },
    });
    expect(checkCognitoAdvancedSecurity(ctx)).toHaveLength(0);
  });

  test("no diagnostic for ENFORCED mode", () => {
    const ctx = makeCtx({
      Resources: {
        MyPool: {
          Type: "AWS::Cognito::UserPool",
          Properties: { UserPoolAddOns: { AdvancedSecurityMode: "ENFORCED" } },
        },
      },
    });
    expect(checkCognitoAdvancedSecurity(ctx)).toHaveLength(0);
  });

  test("skips intrinsic UserPoolAddOns/AdvancedSecurityMode values", () => {
    const ctx = makeCtx({
      Resources: {
        MyPool: { Type: "AWS::Cognito::UserPool", Properties: { UserPoolAddOns: { Ref: "AddOnsParam" } } },
      },
    });
    expect(checkCognitoAdvancedSecurity(ctx)).toHaveLength(0);
  });

  test("no diagnostic for non-UserPool resources", () => {
    const ctx = makeCtx({
      Resources: { MyBucket: { Type: "AWS::S3::Bucket", Properties: {} } },
    });
    expect(checkCognitoAdvancedSecurity(ctx)).toHaveLength(0);
  });
});
