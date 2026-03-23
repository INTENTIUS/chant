import { describe, test, expect } from "bun:test";
import { createPostSynthContext } from "@intentius/chant-test-utils";
import { waw033, checkNullProperties } from "./waw033";

function makeCtx(template: object) {
  return createPostSynthContext({ aws: template });
}

describe("WAW033: Null Values in CloudFormation Resource Properties", () => {
  test("check metadata", () => {
    expect(waw033.id).toBe("WAW033");
    expect(waw033.description.toLowerCase()).toContain("null");
  });

  // ── Top-level null property ──────────────────────────────────────

  test("top-level null property → error with path", () => {
    const ctx = makeCtx({
      Resources: {
        MyRole: {
          Type: "AWS::IAM::InstanceProfile",
          Properties: {
            Roles: [null],
          },
        },
      },
    });
    const diags = checkNullProperties(ctx);
    expect(diags).toHaveLength(1);
    expect(diags[0].checkId).toBe("WAW033");
    expect(diags[0].severity).toBe("error");
    expect(diags[0].entity).toBe("MyRole");
    expect(diags[0].message).toContain("MyRole");
    expect(diags[0].message).toContain("Roles[0]");
  });

  test("nested null property → error with dotted path", () => {
    const ctx = makeCtx({
      Resources: {
        MyHook: {
          Type: "AWS::AutoScaling::LifecycleHook",
          Properties: {
            AutoScalingGroupName: null,
            LifecycleTransition: "autoscaling:EC2_INSTANCE_TERMINATING",
          },
        },
      },
    });
    const diags = checkNullProperties(ctx);
    expect(diags).toHaveLength(1);
    expect(diags[0].entity).toBe("MyHook");
    expect(diags[0].message).toContain("AutoScalingGroupName");
  });

  test("deeply nested null in array → correct path reported", () => {
    const ctx = makeCtx({
      Resources: {
        MyLt: {
          Type: "AWS::EC2::LaunchTemplate",
          Properties: {
            LaunchTemplateData: {
              TagSpecifications: [
                {
                  ResourceType: "instance",
                  Tags: [{ Key: "cluster", Value: null }],
                },
              ],
            },
          },
        },
      },
    });
    const diags = checkNullProperties(ctx);
    expect(diags).toHaveLength(1);
    expect(diags[0].message).toContain("LaunchTemplateData.TagSpecifications[0].Tags[0].Value");
  });

  test("IamInstanceProfile null from wrong attr → error", () => {
    const ctx = makeCtx({
      Resources: {
        MyInstance: {
          Type: "AWS::EC2::Instance",
          Properties: {
            InstanceType: "c5.2xlarge",
            IamInstanceProfile: null,
          },
        },
      },
    });
    const diags = checkNullProperties(ctx);
    expect(diags).toHaveLength(1);
    expect(diags[0].entity).toBe("MyInstance");
    expect(diags[0].message).toContain("IamInstanceProfile");
    expect(diags[0].message).toContain("Ref(resource)");
  });

  // ── Clean template ───────────────────────────────────────────────

  test("all non-null properties → no diagnostic", () => {
    const ctx = makeCtx({
      Resources: {
        MySg: {
          Type: "AWS::EC2::SecurityGroup",
          Properties: {
            GroupDescription: "my sg",
            VpcId: { Ref: "MyVpc" },
            SecurityGroupIngress: [
              { IpProtocol: "tcp", FromPort: 443, ToPort: 443, CidrIp: "10.0.0.0/8" },
            ],
          },
        },
      },
    });
    const diags = checkNullProperties(ctx);
    expect(diags).toHaveLength(0);
  });

  test("resource with no Properties → no diagnostic", () => {
    const ctx = makeCtx({
      Resources: {
        MyWaitHandle: {
          Type: "AWS::CloudFormation::WaitConditionHandle",
        },
      },
    });
    const diags = checkNullProperties(ctx);
    expect(diags).toHaveLength(0);
  });

  // ── Multiple nulls in same resource ─────────────────────────────

  test("multiple null props in same resource → one diagnostic per null", () => {
    const ctx = makeCtx({
      Resources: {
        MyHook: {
          Type: "AWS::AutoScaling::LifecycleHook",
          Properties: {
            AutoScalingGroupName: null,
            LifecycleHookName: null,
            LifecycleTransition: "autoscaling:EC2_INSTANCE_TERMINATING",
          },
        },
      },
    });
    const diags = checkNullProperties(ctx);
    expect(diags).toHaveLength(2);
    expect(diags.every((d) => d.entity === "MyHook")).toBe(true);
  });

  test("empty Resources → no diagnostic", () => {
    const ctx = makeCtx({ Resources: {} });
    const diags = checkNullProperties(ctx);
    expect(diags).toHaveLength(0);
  });
});
