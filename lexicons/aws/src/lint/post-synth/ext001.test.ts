import { describe, test, expect } from "vitest";
import { createPostSynthContext } from "@intentius/chant-test-utils";
import { ext001, checkExtensionConstraints, type ExtensionConstraint } from "./ext001";

function makeCtx(template: object) {
  return createPostSynthContext({ aws: template });
}

/** Synthetic constraint map — no disk dependency. */
function fakeConstraints(): Map<string, ExtensionConstraint[]> {
  return new Map([
    ["AWS::EC2::Instance", [
      {
        name: "SubnetRequired",
        type: "if_then",
        condition: { required: ["InstanceType"] },
        requirement: { required: ["SubnetId"] },
      },
      {
        name: "SpotExcludesPlacement",
        type: "dependent_excluded",
        requirement: { InstanceMarketOptions: ["PlacementGroup"] },
      },
    ]],
    ["AWS::ECS::Service", [
      {
        name: "LaunchTypeOrCapacity",
        type: "required_xor",
        requirement: ["LaunchType", "CapacityProviderStrategy"],
      },
    ]],
    ["AWS::S3::Bucket", [
      {
        name: "EncryptionOrNotification",
        type: "required_or",
        requirement: ["BucketEncryption", "NotificationConfiguration"],
      },
    ]],
  ]);
}

describe("EXT001: Extension Constraint Violation", () => {
  test("check metadata", () => {
    expect(ext001.id).toBe("EXT001");
    expect(ext001.description).toContain("constraint");
  });

  // --- if_then ---

  test("if_then: flags when condition matches and requirement missing", () => {
    const ctx = makeCtx({
      Resources: {
        MyInstance: {
          Type: "AWS::EC2::Instance",
          Properties: { InstanceType: "t3.micro" },
        },
      },
    });
    const diags = checkExtensionConstraints(ctx, fakeConstraints());
    expect(diags).toHaveLength(1);
    expect(diags[0].checkId).toBe("EXT001");
    expect(diags[0].severity).toBe("error");
    expect(diags[0].message).toContain("SubnetRequired");
    expect(diags[0].message).toContain("SubnetId");
    expect(diags[0].entity).toBe("MyInstance");
  });

  test("if_then: no diagnostic when requirement satisfied", () => {
    const ctx = makeCtx({
      Resources: {
        MyInstance: {
          Type: "AWS::EC2::Instance",
          Properties: { InstanceType: "t3.micro", SubnetId: "subnet-123" },
        },
      },
    });
    const diags = checkExtensionConstraints(ctx, fakeConstraints());
    // SubnetRequired satisfied; SpotExcludesPlacement not triggered (no InstanceMarketOptions)
    expect(diags).toHaveLength(0);
  });

  test("if_then: no diagnostic when condition does not match", () => {
    const ctx = makeCtx({
      Resources: {
        MyInstance: {
          Type: "AWS::EC2::Instance",
          Properties: { ImageId: "ami-123" },
        },
      },
    });
    const diags = checkExtensionConstraints(ctx, fakeConstraints());
    expect(diags).toHaveLength(0);
  });

  // --- dependent_excluded ---

  test("dependent_excluded: flags when both present", () => {
    const ctx = makeCtx({
      Resources: {
        MyInstance: {
          Type: "AWS::EC2::Instance",
          Properties: {
            InstanceMarketOptions: { MarketType: "spot" },
            PlacementGroup: "my-group",
            SubnetId: "subnet-123",
            InstanceType: "t3.micro",
          },
        },
      },
    });
    const diags = checkExtensionConstraints(ctx, fakeConstraints());
    const excluded = diags.filter((d) => d.message.includes("excludes"));
    expect(excluded).toHaveLength(1);
    expect(excluded[0].message).toContain("InstanceMarketOptions");
    expect(excluded[0].message).toContain("PlacementGroup");
  });

  test("dependent_excluded: no diagnostic when excluded prop absent", () => {
    const ctx = makeCtx({
      Resources: {
        MyInstance: {
          Type: "AWS::EC2::Instance",
          Properties: {
            InstanceMarketOptions: { MarketType: "spot" },
            SubnetId: "subnet-123",
            InstanceType: "t3.micro",
          },
        },
      },
    });
    const diags = checkExtensionConstraints(ctx, fakeConstraints());
    const excluded = diags.filter((d) => d.message.includes("excludes"));
    expect(excluded).toHaveLength(0);
  });

  // --- required_xor ---

  test("required_xor: flags when neither present", () => {
    const ctx = makeCtx({
      Resources: {
        MySvc: {
          Type: "AWS::ECS::Service",
          Properties: { ServiceName: "my-svc" },
        },
      },
    });
    const diags = checkExtensionConstraints(ctx, fakeConstraints());
    expect(diags).toHaveLength(1);
    expect(diags[0].message).toContain("exactly one of");
    expect(diags[0].message).toContain("found 0");
  });

  test("required_xor: flags when both present", () => {
    const ctx = makeCtx({
      Resources: {
        MySvc: {
          Type: "AWS::ECS::Service",
          Properties: {
            LaunchType: "FARGATE",
            CapacityProviderStrategy: [{}],
          },
        },
      },
    });
    const diags = checkExtensionConstraints(ctx, fakeConstraints());
    expect(diags).toHaveLength(1);
    expect(diags[0].message).toContain("found 2");
  });

  test("required_xor: no diagnostic when exactly one present", () => {
    const ctx = makeCtx({
      Resources: {
        MySvc: {
          Type: "AWS::ECS::Service",
          Properties: { LaunchType: "FARGATE" },
        },
      },
    });
    const diags = checkExtensionConstraints(ctx, fakeConstraints());
    expect(diags).toHaveLength(0);
  });

  // --- required_or ---

  test("required_or: flags when none present", () => {
    const ctx = makeCtx({
      Resources: {
        MyBucket: {
          Type: "AWS::S3::Bucket",
          Properties: { BucketName: "test" },
        },
      },
    });
    const diags = checkExtensionConstraints(ctx, fakeConstraints());
    expect(diags).toHaveLength(1);
    expect(diags[0].message).toContain("at least one of");
  });

  test("required_or: no diagnostic when one present", () => {
    const ctx = makeCtx({
      Resources: {
        MyBucket: {
          Type: "AWS::S3::Bucket",
          Properties: { BucketEncryption: {} },
        },
      },
    });
    const diags = checkExtensionConstraints(ctx, fakeConstraints());
    expect(diags).toHaveLength(0);
  });

  // --- Edge cases ---

  test("no diagnostics for resource type not in constraints", () => {
    const ctx = makeCtx({
      Resources: {
        MyRole: {
          Type: "AWS::IAM::Role",
          Properties: { RoleName: "test" },
        },
      },
    });
    const diags = checkExtensionConstraints(ctx, fakeConstraints());
    expect(diags).toHaveLength(0);
  });

  test("no diagnostics on empty template", () => {
    const ctx = makeCtx({ Resources: {} });
    const diags = checkExtensionConstraints(ctx, fakeConstraints());
    expect(diags).toHaveLength(0);
  });

  test("returns empty when constraint map is empty", () => {
    const ctx = makeCtx({
      Resources: {
        MyInstance: {
          Type: "AWS::EC2::Instance",
          Properties: { InstanceType: "t3.micro" },
        },
      },
    });
    const diags = checkExtensionConstraints(ctx, new Map());
    expect(diags).toHaveLength(0);
  });

  test("handles invalid JSON output gracefully", () => {
    const ctx = createPostSynthContext({ aws: "not json" as unknown as object });
    const diags = checkExtensionConstraints(ctx, fakeConstraints());
    expect(diags).toHaveLength(0);
  });
});

describe("EXT001: schema keywords in a condition", () => {
  // The S3 constraint as the generated lexicon carries it: OwnershipControls is
  // required unless AccessControl is one of the three private canned ACLs.
  const s3Constraint: ExtensionConstraint = {
    name: "ownershipcontrols",
    type: "if_then",
    condition: {
      properties: {
        AccessControl: { not: { enum: ["Private", "BucketOwnerFullControl", "BucketOwnerRead"] }, type: "string" },
      },
      required: ["AccessControl"],
    },
    requirement: { properties: { OwnershipControls: { required: ["Rules"] } }, required: ["OwnershipControls"] },
  };
  const s3 = new Map([["AWS::S3::Bucket", [s3Constraint]]]);
  const bucket = (props: Record<string, unknown>) =>
    makeCtx({ Resources: { B: { Type: "AWS::S3::Bucket", Properties: props } } });

  test.each(["Private", "BucketOwnerFullControl", "BucketOwnerRead"])(
    "not enum: AccessControl %s is exempt",
    (acl) => {
      expect(checkExtensionConstraints(bucket({ AccessControl: acl }), s3)).toHaveLength(0);
    },
  );

  test.each(["PublicRead", "PublicReadWrite", "AuthenticatedRead", "LogDeliveryWrite"])(
    "still flags: AccessControl %s without OwnershipControls",
    (acl) => {
      const diags = checkExtensionConstraints(bucket({ AccessControl: acl }), s3);
      expect(diags).toHaveLength(1);
      expect(diags[0].message).toContain("OwnershipControls");
    },
  );

  test("still satisfied: public ACL with OwnershipControls", () => {
    const ctx = bucket({ AccessControl: "PublicRead", OwnershipControls: { Rules: [{ ObjectOwnership: "BucketOwnerPreferred" }] } });
    expect(checkExtensionConstraints(ctx, s3)).toHaveLength(0);
  });

  test("no finding without AccessControl", () => {
    expect(checkExtensionConstraints(bucket({ BucketName: "x" }), s3)).toHaveLength(0);
  });

  test("undecidable value stays silent: Ref and Fn::If", () => {
    expect(checkExtensionConstraints(bucket({ AccessControl: { Ref: "Acl" } }), s3)).toHaveLength(0);
    const cond = { "Fn::If": ["Public", "PublicRead", "Private"] };
    expect(checkExtensionConstraints(bucket({ AccessControl: cond }), s3)).toHaveLength(0);
  });

  test("a keyword the check does not evaluate keeps the finding silent", () => {
    const map = new Map<string, ExtensionConstraint[]>([
      ["AWS::S3::Bucket", [{
        name: "unknown-keyword",
        type: "if_then",
        condition: { properties: { AccessControl: { format: "something" } }, required: ["AccessControl"] },
        requirement: { required: ["OwnershipControls"] },
      }]],
    ]);
    expect(checkExtensionConstraints(bucket({ AccessControl: "PublicRead" }), map)).toHaveLength(0);
  });

  test("type narrows a condition", () => {
    const map = new Map<string, ExtensionConstraint[]>([
      ["AWS::S3::Bucket", [{
        name: "typed",
        type: "if_then",
        condition: { properties: { AccessControl: { type: "string" } }, required: ["AccessControl"] },
        requirement: { required: ["OwnershipControls"] },
      }]],
    ]);
    expect(checkExtensionConstraints(bucket({ AccessControl: "PublicRead" }), map)).toHaveLength(1);
    expect(checkExtensionConstraints(bucket({ AccessControl: ["x"] }), map)).toHaveLength(0);
  });

  test("anyOf, oneOf, allOf and a false property schema", () => {
    const rule = (condition: unknown) =>
      new Map<string, ExtensionConstraint[]>([
        ["AWS::ElasticLoadBalancingV2::LoadBalancer", [{
          name: "c", type: "if_then", condition, requirement: { required: ["Subnets"] },
        }]],
      ]);
    const lb = (props: Record<string, unknown>) =>
      makeCtx({ Resources: { L: { Type: "AWS::ElasticLoadBalancingV2::LoadBalancer", Properties: props } } });
    // The generated shape: type is application, or absent.
    const oneOf = rule({
      oneOf: [
        { properties: { Type: { const: "application" } }, required: ["Type"] },
        { properties: { Type: false } },
      ],
    });
    expect(checkExtensionConstraints(lb({ Type: "application" }), oneOf)).toHaveLength(1);
    expect(checkExtensionConstraints(lb({ Name: "n" }), oneOf)).toHaveLength(1);
    expect(checkExtensionConstraints(lb({ Type: "network" }), oneOf)).toHaveLength(0);

    const anyOf = rule({ anyOf: [{ required: ["A"] }, { required: ["B"] }] });
    expect(checkExtensionConstraints(lb({ B: 1 }), anyOf)).toHaveLength(1);
    expect(checkExtensionConstraints(lb({ C: 1 }), anyOf)).toHaveLength(0);

    const allOf = rule({ allOf: [{ required: ["A"] }, { not: { required: ["B"] } }] });
    expect(checkExtensionConstraints(lb({ A: 1 }), allOf)).toHaveLength(1);
    expect(checkExtensionConstraints(lb({ A: 1, B: 1 }), allOf)).toHaveLength(0);
  });
});

describe("EXT001: generated lexicon constraints", () => {
  const bucket = (props: Record<string, unknown>) =>
    makeCtx({ Resources: { B: { Type: "AWS::S3::Bucket", Properties: props } } });

  test("AccessControl Private is not flagged; PublicRead without OwnershipControls is", () => {
    expect(ext001.check(bucket({ AccessControl: "Private" }))).toHaveLength(0);
    expect(ext001.check(bucket({ AccessControl: "PublicRead" }))).toHaveLength(1);
  });
});
