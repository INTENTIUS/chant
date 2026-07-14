import { describe, test, expect } from "vitest";
import { createPostSynthContext } from "@intentius/chant-test-utils";
import { waw052, checkCognitoMfaRequired } from "./waw052";

function makeCtx(template: object, env?: string) {
  return { ...createPostSynthContext({ aws: template }), env };
}

const template = {
  Resources: {
    MyPool: { Type: "AWS::Cognito::UserPool", Properties: { MfaConfiguration: "OPTIONAL" } },
  },
};

describe("WAW052: Cognito MFA Not Required (full tier)", () => {
  test("check metadata", () => {
    expect(waw052.id).toBe("WAW052");
    expect(waw052.description).toContain("MFA");
  });

  test("warns (not errors) on the light tier — no env set", () => {
    const diags = checkCognitoMfaRequired(makeCtx(template));
    expect(diags).toHaveLength(1);
    expect(diags[0].checkId).toBe("WAW052");
    expect(diags[0].severity).toBe("warning");
  });

  test("warns on a non-production env", () => {
    expect(checkCognitoMfaRequired(makeCtx(template, "dev"))[0].severity).toBe("warning");
  });

  test("errors on the full/production tier", () => {
    const diags = checkCognitoMfaRequired(makeCtx(template, "production"));
    expect(diags).toHaveLength(1);
    expect(diags[0].severity).toBe("error");
  });

  test("flags MfaConfiguration: OFF too", () => {
    const offTemplate = { Resources: { MyPool: { Type: "AWS::Cognito::UserPool", Properties: { MfaConfiguration: "OFF" } } } };
    expect(checkCognitoMfaRequired(makeCtx(offTemplate, "prod"))).toHaveLength(1);
  });

  test("no diagnostic when MfaConfiguration: ON, even in prod", () => {
    const onTemplate = { Resources: { MyPool: { Type: "AWS::Cognito::UserPool", Properties: { MfaConfiguration: "ON" } } } };
    expect(checkCognitoMfaRequired(makeCtx(onTemplate, "prod"))).toHaveLength(0);
  });

  test("skips intrinsic MfaConfiguration values", () => {
    const paramTemplate = {
      Resources: { MyPool: { Type: "AWS::Cognito::UserPool", Properties: { MfaConfiguration: { Ref: "MfaParam" } } } },
    };
    expect(checkCognitoMfaRequired(makeCtx(paramTemplate, "prod"))).toHaveLength(0);
  });
});
