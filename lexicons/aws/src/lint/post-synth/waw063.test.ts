import { describe, test, expect } from "vitest";
import { createPostSynthContext } from "@intentius/chant-test-utils";
import { waw063, checkDenyAllowContradiction } from "./waw063";

function makeCtx(template: object) {
  return createPostSynthContext({ aws: template });
}

describe("WAW063: IAM Policy Denies An Action It Also Allows", () => {
  test("check metadata", () => {
    expect(waw063.id).toBe("WAW063");
    expect(waw063.description).toContain("Deny");
  });

  test("guardrail policy denies exactly what a workflow policy allows on the same role → error", () => {
    // Mirrors the issue's own example: a role used by a StepFunctions workflow
    // needs ec2:ModifyInstanceAttribute; a separately-attached guardrail policy
    // denies it. Deploy succeeds; the workflow 403s at runtime.
    const ctx = makeCtx({
      Resources: {
        WorkflowRole: { Type: "AWS::IAM::Role", Properties: { AssumeRolePolicyDocument: { Statement: [] } } },
        WorkflowPolicy: {
          Type: "AWS::IAM::Policy",
          Properties: {
            PolicyName: "workflow-needs",
            Roles: [{ Ref: "WorkflowRole" }],
            PolicyDocument: {
              Statement: [{ Effect: "Allow", Action: "ec2:ModifyInstanceAttribute", Resource: "*" }],
            },
          },
        },
        SecurityGuardrailPolicy: {
          Type: "AWS::IAM::Policy",
          Properties: {
            PolicyName: "guardrail",
            Roles: [{ Ref: "WorkflowRole" }],
            PolicyDocument: {
              Statement: [{ Effect: "Deny", Action: "ec2:ModifyInstanceAttribute", Resource: "*" }],
            },
          },
        },
      },
    });
    const diags = checkDenyAllowContradiction(ctx);
    expect(diags).toHaveLength(1);
    expect(diags[0].checkId).toBe("WAW063");
    expect(diags[0].severity).toBe("error");
    expect(diags[0].entity).toBe("WorkflowRole");
    expect(diags[0].message).toContain("ec2:ModifyInstanceAttribute");
    expect(diags[0].message).toContain("SecurityGuardrailPolicy");
    expect(diags[0].message).toContain("WorkflowPolicy");
    expect(diags[0].lexicon).toBe("aws");
  });

  test("wildcarded Deny nullifies a literal Allow on the same role's inline policy → error", () => {
    const ctx = makeCtx({
      Resources: {
        AppRole: {
          Type: "AWS::IAM::Role",
          Properties: {
            AssumeRolePolicyDocument: { Statement: [] },
            Policies: [
              {
                PolicyName: "inline",
                PolicyDocument: {
                  Statement: [
                    { Effect: "Allow", Action: "s3:GetObject", Resource: "*" },
                    { Effect: "Deny", Action: "s3:*", Resource: "*" },
                  ],
                },
              },
            ],
          },
        },
      },
    });
    expect(checkDenyAllowContradiction(ctx)).toHaveLength(1);
  });

  test("broad Allow with a narrow safety Deny (intentional guardrail) → no diagnostic", () => {
    const ctx = makeCtx({
      Resources: {
        AppRole: {
          Type: "AWS::IAM::Role",
          Properties: {
            AssumeRolePolicyDocument: { Statement: [] },
            Policies: [
              {
                PolicyName: "inline",
                PolicyDocument: {
                  Statement: [
                    { Effect: "Allow", Action: "ec2:*", Resource: "*" },
                    { Effect: "Deny", Action: "ec2:TerminateInstances", Resource: "*" },
                  ],
                },
              },
            ],
          },
        },
      },
    });
    expect(checkDenyAllowContradiction(ctx)).toHaveLength(0);
  });

  test("Deny on a different role than the Allow → no diagnostic", () => {
    const ctx = makeCtx({
      Resources: {
        RoleA: {
          Type: "AWS::IAM::Role",
          Properties: {
            AssumeRolePolicyDocument: { Statement: [] },
            Policies: [{ PolicyName: "p", PolicyDocument: { Statement: [{ Effect: "Allow", Action: "ec2:ModifyInstanceAttribute", Resource: "*" }] } }],
          },
        },
        RoleB: {
          Type: "AWS::IAM::Role",
          Properties: {
            AssumeRolePolicyDocument: { Statement: [] },
            Policies: [{ PolicyName: "p", PolicyDocument: { Statement: [{ Effect: "Deny", Action: "ec2:ModifyInstanceAttribute", Resource: "*" }] } }],
          },
        },
      },
    });
    expect(checkDenyAllowContradiction(ctx)).toHaveLength(0);
  });

  test("Deny scoped to a disjoint literal resource → no diagnostic", () => {
    const ctx = makeCtx({
      Resources: {
        AppRole: {
          Type: "AWS::IAM::Role",
          Properties: {
            AssumeRolePolicyDocument: { Statement: [] },
            Policies: [
              {
                PolicyName: "inline",
                PolicyDocument: {
                  Statement: [
                    { Effect: "Allow", Action: "s3:GetObject", Resource: "arn:aws:s3:::bucket-a/*" },
                    { Effect: "Deny", Action: "s3:GetObject", Resource: "arn:aws:s3:::bucket-b/*" },
                  ],
                },
              },
            ],
          },
        },
      },
    });
    expect(checkDenyAllowContradiction(ctx)).toHaveLength(0);
  });

  test("conditional Deny is skipped (unprovable statically) → no diagnostic", () => {
    const ctx = makeCtx({
      Resources: {
        AppRole: {
          Type: "AWS::IAM::Role",
          Properties: {
            AssumeRolePolicyDocument: { Statement: [] },
            Policies: [
              {
                PolicyName: "inline",
                PolicyDocument: {
                  Statement: [
                    { Effect: "Allow", Action: "s3:GetObject", Resource: "*" },
                    {
                      Effect: "Deny",
                      Action: "s3:GetObject",
                      Resource: "*",
                      Condition: { StringNotEquals: { "aws:SourceVpc": "vpc-123" } },
                    },
                  ],
                },
              },
            ],
          },
        },
      },
    });
    expect(checkDenyAllowContradiction(ctx)).toHaveLength(0);
  });

  test("Deny from a managed policy attached via ManagedPolicyArns collides with an inline Allow → error", () => {
    const ctx = makeCtx({
      Resources: {
        AppRole: {
          Type: "AWS::IAM::Role",
          Properties: {
            AssumeRolePolicyDocument: { Statement: [] },
            ManagedPolicyArns: [{ Ref: "GuardrailManagedPolicy" }],
            Policies: [{ PolicyName: "inline", PolicyDocument: { Statement: [{ Effect: "Allow", Action: "ec2:ModifyInstanceAttribute", Resource: "*" }] } }],
          },
        },
        GuardrailManagedPolicy: {
          Type: "AWS::IAM::ManagedPolicy",
          Properties: {
            PolicyDocument: { Statement: [{ Effect: "Deny", Action: "ec2:ModifyInstanceAttribute", Resource: "*" }] },
          },
        },
      },
    });
    const diags = checkDenyAllowContradiction(ctx);
    expect(diags).toHaveLength(1);
    expect(diags[0].message).toContain("GuardrailManagedPolicy");
  });

  test("role with only Allow statements → no diagnostic", () => {
    const ctx = makeCtx({
      Resources: {
        AppRole: {
          Type: "AWS::IAM::Role",
          Properties: {
            AssumeRolePolicyDocument: { Statement: [] },
            Policies: [{ PolicyName: "p", PolicyDocument: { Statement: [{ Effect: "Allow", Action: "s3:GetObject", Resource: "*" }] } }],
          },
        },
      },
    });
    expect(checkDenyAllowContradiction(ctx)).toHaveLength(0);
  });
});
