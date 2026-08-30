import { describe, test, expect } from "vitest";
import { createPostSynthContext } from "@intentius/chant-test-utils";
import { waw061, checkSubnetCidrContainment } from "./waw061";

function makeCtx(template: object) {
  return createPostSynthContext({ aws: template });
}

describe("WAW061: Subnet CIDR Not Contained In VPC CIDR", () => {
  test("check metadata", () => {
    expect(waw061.id).toBe("WAW061");
    expect(waw061.description).toContain("CidrBlock");
  });

  test("subnet CIDR outside the VPC's CIDR range → error", () => {
    const ctx = makeCtx({
      Resources: {
        MyVpc: { Type: "AWS::EC2::VPC", Properties: { CidrBlock: "10.0.0.0/16" } },
        MySubnet: {
          Type: "AWS::EC2::Subnet",
          Properties: { CidrBlock: "10.1.0.0/24", VpcId: { Ref: "MyVpc" } },
        },
      },
    });
    const diags = checkSubnetCidrContainment(ctx);
    expect(diags).toHaveLength(1);
    expect(diags[0].checkId).toBe("WAW061");
    expect(diags[0].severity).toBe("error");
    expect(diags[0].entity).toBe("MySubnet");
    expect(diags[0].message).toContain("10.1.0.0/24");
    expect(diags[0].message).toContain("10.0.0.0/16");
    expect(diags[0].lexicon).toBe("aws");
  });

  test("subnet wider than its VPC → error", () => {
    const ctx = makeCtx({
      Resources: {
        MyVpc: { Type: "AWS::EC2::VPC", Properties: { CidrBlock: "10.0.1.0/24" } },
        MySubnet: {
          Type: "AWS::EC2::Subnet",
          Properties: { CidrBlock: "10.0.0.0/16", VpcId: { Ref: "MyVpc" } },
        },
      },
    });
    expect(checkSubnetCidrContainment(ctx)).toHaveLength(1);
  });

  test("subnet CIDR contained in the VPC's CIDR → no diagnostic", () => {
    const ctx = makeCtx({
      Resources: {
        MyVpc: { Type: "AWS::EC2::VPC", Properties: { CidrBlock: "10.0.0.0/16" } },
        MySubnet: {
          Type: "AWS::EC2::Subnet",
          Properties: { CidrBlock: "10.0.1.0/24", VpcId: { Ref: "MyVpc" } },
        },
      },
    });
    expect(checkSubnetCidrContainment(ctx)).toHaveLength(0);
  });

  test("intrinsic CidrBlock → no diagnostic (unprovable)", () => {
    const ctx = makeCtx({
      Resources: {
        MyVpc: { Type: "AWS::EC2::VPC", Properties: { CidrBlock: "10.0.0.0/16" } },
        MySubnet: {
          Type: "AWS::EC2::Subnet",
          Properties: {
            CidrBlock: { "Fn::Select": [0, { "Fn::Cidr": [{ "Fn::GetAtt": ["MyVpc", "CidrBlock"] }, 4, 8] }] },
            VpcId: { Ref: "MyVpc" },
          },
        },
      },
    });
    expect(checkSubnetCidrContainment(ctx)).toHaveLength(0);
  });

  test("VpcId not resolvable to a declared VPC (imported) → no diagnostic", () => {
    const ctx = makeCtx({
      Resources: {
        MySubnet: {
          Type: "AWS::EC2::Subnet",
          Properties: { CidrBlock: "10.1.0.0/24", VpcId: { "Fn::ImportValue": "shared-vpc-id" } },
        },
      },
    });
    expect(checkSubnetCidrContainment(ctx)).toHaveLength(0);
  });

  test("multiple subnets in a VPC, all contained → no diagnostic", () => {
    const ctx = makeCtx({
      Resources: {
        MyVpc: { Type: "AWS::EC2::VPC", Properties: { CidrBlock: "10.0.0.0/16" } },
        SubnetA: { Type: "AWS::EC2::Subnet", Properties: { CidrBlock: "10.0.0.0/24", VpcId: { Ref: "MyVpc" } } },
        SubnetB: { Type: "AWS::EC2::Subnet", Properties: { CidrBlock: "10.0.1.0/24", VpcId: { Ref: "MyVpc" } } },
      },
    });
    expect(checkSubnetCidrContainment(ctx)).toHaveLength(0);
  });
});
