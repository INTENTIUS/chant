import { describe, test, expect } from "vitest";
import { createPostSynthContext } from "@intentius/chant-test-utils";
import { waw066, checkPrivateSubnetDefaultRoute } from "./waw066";

function makeCtx(template: object) {
  return createPostSynthContext({ aws: template });
}

describe("WAW066: Private Subnet Route Table Has No Working Default Route", () => {
  test("check metadata", () => {
    expect(waw066.id).toBe("WAW066");
    expect(waw066.description).toContain("default route");
  });

  test("subnet's route table has no default route at all → warning", () => {
    const ctx = makeCtx({
      Resources: {
        PrivateSubnet: { Type: "AWS::EC2::Subnet", Properties: { VpcId: { Ref: "Vpc" }, CidrBlock: "10.0.1.0/24" } },
        PrivateRouteTable: { Type: "AWS::EC2::RouteTable", Properties: { VpcId: { Ref: "Vpc" } } },
        PrivateAssoc: {
          Type: "AWS::EC2::SubnetRouteTableAssociation",
          Properties: { SubnetId: { Ref: "PrivateSubnet" }, RouteTableId: { Ref: "PrivateRouteTable" } },
        },
        Vpc: { Type: "AWS::EC2::VPC", Properties: { CidrBlock: "10.0.0.0/16" } },
      },
    });
    const diags = checkPrivateSubnetDefaultRoute(ctx);
    expect(diags).toHaveLength(1);
    expect(diags[0].checkId).toBe("WAW066");
    expect(diags[0].severity).toBe("warning");
    expect(diags[0].entity).toBe("PrivateSubnet");
    expect(diags[0].message).toContain("no default route");
  });

  test("default route targets a NAT gateway that does not exist in the template → error", () => {
    const ctx = makeCtx({
      Resources: {
        PrivateSubnet: { Type: "AWS::EC2::Subnet", Properties: { VpcId: { Ref: "Vpc" }, CidrBlock: "10.0.1.0/24" } },
        PrivateRouteTable: { Type: "AWS::EC2::RouteTable", Properties: { VpcId: { Ref: "Vpc" } } },
        PrivateAssoc: {
          Type: "AWS::EC2::SubnetRouteTableAssociation",
          Properties: { SubnetId: { Ref: "PrivateSubnet" }, RouteTableId: { Ref: "PrivateRouteTable" } },
        },
        DefaultRoute: {
          Type: "AWS::EC2::Route",
          Properties: { RouteTableId: { Ref: "PrivateRouteTable" }, DestinationCidrBlock: "0.0.0.0/0", NatGatewayId: { Ref: "RemovedNatGateway" } },
        },
        Vpc: { Type: "AWS::EC2::VPC", Properties: { CidrBlock: "10.0.0.0/16" } },
      },
    });
    const diags = checkPrivateSubnetDefaultRoute(ctx);
    expect(diags).toHaveLength(1);
    expect(diags[0].severity).toBe("error");
    expect(diags[0].entity).toBe("PrivateSubnet");
    expect(diags[0].message).toContain("does not exist in this template");
  });

  test("default route to a NAT gateway that exists in the template → no diagnostic", () => {
    const ctx = makeCtx({
      Resources: {
        PrivateSubnet: { Type: "AWS::EC2::Subnet", Properties: { VpcId: { Ref: "Vpc" }, CidrBlock: "10.0.1.0/24" } },
        PrivateRouteTable: { Type: "AWS::EC2::RouteTable", Properties: { VpcId: { Ref: "Vpc" } } },
        PrivateAssoc: {
          Type: "AWS::EC2::SubnetRouteTableAssociation",
          Properties: { SubnetId: { Ref: "PrivateSubnet" }, RouteTableId: { Ref: "PrivateRouteTable" } },
        },
        DefaultRoute: {
          Type: "AWS::EC2::Route",
          Properties: { RouteTableId: { Ref: "PrivateRouteTable" }, DestinationCidrBlock: "0.0.0.0/0", NatGatewayId: { Ref: "NatGateway" } },
        },
        NatGateway: { Type: "AWS::EC2::NatGateway", Properties: { SubnetId: { Ref: "PublicSubnet" } } },
        PublicSubnet: { Type: "AWS::EC2::Subnet", Properties: { VpcId: { Ref: "Vpc" }, CidrBlock: "10.0.0.0/24" } },
        Vpc: { Type: "AWS::EC2::VPC", Properties: { CidrBlock: "10.0.0.0/16" } },
      },
    });
    expect(checkPrivateSubnetDefaultRoute(ctx)).toHaveLength(0);
  });

  test("public subnet with a default route to an existing Internet Gateway → no diagnostic (out of scope)", () => {
    const ctx = makeCtx({
      Resources: {
        PublicSubnet: { Type: "AWS::EC2::Subnet", Properties: { VpcId: { Ref: "Vpc" }, CidrBlock: "10.0.0.0/24" } },
        PublicRouteTable: { Type: "AWS::EC2::RouteTable", Properties: { VpcId: { Ref: "Vpc" } } },
        PublicAssoc: {
          Type: "AWS::EC2::SubnetRouteTableAssociation",
          Properties: { SubnetId: { Ref: "PublicSubnet" }, RouteTableId: { Ref: "PublicRouteTable" } },
        },
        DefaultRoute: {
          Type: "AWS::EC2::Route",
          Properties: { RouteTableId: { Ref: "PublicRouteTable" }, DestinationCidrBlock: "0.0.0.0/0", GatewayId: { Ref: "Igw" } },
        },
        Igw: { Type: "AWS::EC2::InternetGateway", Properties: {} },
        Vpc: { Type: "AWS::EC2::VPC", Properties: { CidrBlock: "10.0.0.0/16" } },
      },
    });
    expect(checkPrivateSubnetDefaultRoute(ctx)).toHaveLength(0);
  });

  test("subnet with no explicit route table association → no diagnostic (out of scope, can't prove)", () => {
    const ctx = makeCtx({
      Resources: {
        Subnet: { Type: "AWS::EC2::Subnet", Properties: { VpcId: { Ref: "Vpc" }, CidrBlock: "10.0.1.0/24" } },
        Vpc: { Type: "AWS::EC2::VPC", Properties: { CidrBlock: "10.0.0.0/16" } },
      },
    });
    expect(checkPrivateSubnetDefaultRoute(ctx)).toHaveLength(0);
  });
});
