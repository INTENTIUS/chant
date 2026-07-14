import { describe, test, expect } from "vitest";
import { createPostSynthContext } from "@intentius/chant-test-utils";
import { waw051, checkCognitoImplicitGrant } from "./waw051";

function makeCtx(template: object) {
  return createPostSynthContext({ aws: template });
}

describe("WAW051: Cognito Implicit OAuth Grant Allowed", () => {
  test("check metadata", () => {
    expect(waw051.id).toBe("WAW051");
    expect(waw051.description).toContain("implicit");
  });

  test("flags a client allowing the implicit grant", () => {
    const ctx = makeCtx({
      Resources: {
        MyClient: {
          Type: "AWS::Cognito::UserPoolClient",
          Properties: { AllowedOAuthFlows: ["implicit"] },
        },
      },
    });
    const diags = checkCognitoImplicitGrant(ctx);
    expect(diags).toHaveLength(1);
    expect(diags[0].checkId).toBe("WAW051");
  });

  test("flags when implicit is one of several allowed flows", () => {
    const ctx = makeCtx({
      Resources: {
        MyClient: {
          Type: "AWS::Cognito::UserPoolClient",
          Properties: { AllowedOAuthFlows: ["code", "implicit"] },
        },
      },
    });
    expect(checkCognitoImplicitGrant(ctx)).toHaveLength(1);
  });

  test("no diagnostic for the authorization code grant only", () => {
    const ctx = makeCtx({
      Resources: {
        MyClient: {
          Type: "AWS::Cognito::UserPoolClient",
          Properties: { AllowedOAuthFlows: ["code"] },
        },
      },
    });
    expect(checkCognitoImplicitGrant(ctx)).toHaveLength(0);
  });

  test("no diagnostic when AllowedOAuthFlows is unset", () => {
    const ctx = makeCtx({
      Resources: { MyClient: { Type: "AWS::Cognito::UserPoolClient", Properties: {} } },
    });
    expect(checkCognitoImplicitGrant(ctx)).toHaveLength(0);
  });

  test("skips intrinsic AllowedOAuthFlows values", () => {
    const ctx = makeCtx({
      Resources: {
        MyClient: {
          Type: "AWS::Cognito::UserPoolClient",
          Properties: { AllowedOAuthFlows: { Ref: "FlowsParam" } },
        },
      },
    });
    expect(checkCognitoImplicitGrant(ctx)).toHaveLength(0);
  });

  test("no diagnostic for non-UserPoolClient resources", () => {
    const ctx = makeCtx({
      Resources: { MyPool: { Type: "AWS::Cognito::UserPool", Properties: {} } },
    });
    expect(checkCognitoImplicitGrant(ctx)).toHaveLength(0);
  });
});
