import { describe, test, expect } from "vitest";
import { createPostSynthContext } from "@intentius/chant-test-utils";
import { waw060, checkPolicyUnattached } from "./waw060";

function makeCtx(template: object) {
  return createPostSynthContext({ aws: template });
}

const ALLOW_S3_READ = {
  Version: "2012-10-17",
  Statement: [{ Effect: "Allow", Action: ["s3:GetObject"], Resource: "arn:aws:s3:::data/*" }],
};

function managedPolicy(extra?: Record<string, unknown>) {
  return {
    Type: "AWS::IAM::ManagedPolicy",
    Properties: { PolicyDocument: ALLOW_S3_READ, ...extra },
  };
}

function inlinePolicy(extra?: Record<string, unknown>) {
  return {
    Type: "AWS::IAM::Policy",
    Properties: { PolicyName: "read", PolicyDocument: ALLOW_S3_READ, ...extra },
  };
}

function role(extra?: Record<string, unknown>) {
  return {
    Type: "AWS::IAM::Role",
    Properties: {
      AssumeRolePolicyDocument: {
        Version: "2012-10-17",
        Statement: [{ Effect: "Allow", Principal: { Service: "lambda.amazonaws.com" }, Action: "sts:AssumeRole" }],
      },
      ...extra,
    },
  };
}

describe("WAW060: IAM policy attached to no principal", () => {
  test("check metadata", () => {
    expect(waw060.id).toBe("WAW060");
    expect(waw060.description).toContain("principal");
  });

  test("flags an unattached IAM::Policy", () => {
    const ctx = makeCtx({ Resources: { Orphan: inlinePolicy() } });
    const diags = checkPolicyUnattached(ctx);
    expect(diags).toHaveLength(1);
    expect(diags[0].checkId).toBe("WAW060");
    expect(diags[0].severity).toBe("warning");
    expect(diags[0].entity).toBe("Orphan");
    expect(diags[0].message).toContain("grants nothing");
  });

  test("flags an unattached ManagedPolicy and one with empty principal lists", () => {
    const ctx = makeCtx({
      Resources: {
        Orphan: managedPolicy(),
        EmptyLists: managedPolicy({ Roles: [], Users: [], Groups: [] }),
      },
    });
    const diags = checkPolicyUnattached(ctx);
    expect(diags.map((d) => d.entity).sort()).toEqual(["EmptyLists", "Orphan"]);
  });

  test("quiet when a role's ManagedPolicyArns references the policy", () => {
    const ctx = makeCtx({
      Resources: {
        ReadPolicy: managedPolicy(),
        AppRole: role({ ManagedPolicyArns: [{ Ref: "ReadPolicy" }] }),
      },
    });
    expect(checkPolicyUnattached(ctx)).toHaveLength(0);
  });

  test("quiet when the policy declares a Roles list", () => {
    const ctx = makeCtx({
      Resources: {
        AppRole: role(),
        ReadPolicy: managedPolicy({ Roles: [{ Ref: "AppRole" }] }),
        InlineRead: inlinePolicy({ Roles: [{ Ref: "AppRole" }] }),
      },
    });
    expect(checkPolicyUnattached(ctx)).toHaveLength(0);
  });

  test("AWS-managed ARN strings elsewhere do not attach the template's own policy", () => {
    const ctx = makeCtx({
      Resources: {
        Orphan: managedPolicy(),
        AppRole: role({ ManagedPolicyArns: ["arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"] }),
      },
    });
    const diags = checkPolicyUnattached(ctx);
    expect(diags).toHaveLength(1);
    expect(diags[0].entity).toBe("Orphan");
  });

  test("quiet on attachment-style resources and GetAtt edges", () => {
    const ctx = makeCtx({
      Resources: {
        ReadPolicy: managedPolicy(),
        Attachment: {
          Type: "AWS::SSO::PermissionSet",
          Properties: { ManagedPolicies: [{ "Fn::GetAtt": ["ReadPolicy", "PolicyArn"] }] },
        },
      },
    });
    expect(checkPolicyUnattached(ctx)).toHaveLength(0);
  });

  test("an Output exporting the policy counts as a reference", () => {
    const ctx = makeCtx({
      Resources: { SharedPolicy: managedPolicy() },
      Outputs: { SharedPolicyArn: { Value: { Ref: "SharedPolicy" }, Export: { Name: "shared-read" } } },
    });
    expect(checkPolicyUnattached(ctx)).toHaveLength(0);
  });

  test("intrinsic principal lists are skipped, and non-policy IAM types are ignored", () => {
    const ctx = makeCtx({
      Resources: {
        Conditional: managedPolicy({ Roles: { "Fn::If": ["UseRole", [{ Ref: "AppRole" }], []] } }),
        AppRole: role(),
      },
    });
    expect(checkPolicyUnattached(ctx)).toHaveLength(0);
  });
});
