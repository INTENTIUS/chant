import { describe, test, expect } from "vitest";
import { createPostSynthContext } from "@intentius/chant-test-utils";
import { waw067, checkNatGatewaySingleAz } from "./waw067";

function makeCtx(template: object) {
  return createPostSynthContext({ aws: template });
}

describe("WAW067: Single-AZ NAT Gateway Serves Multi-AZ Private Subnets", () => {
  test("check metadata", () => {
    expect(waw067.id).toBe("WAW067");
    expect(waw067.description).toContain("NAT gateway");
  });

  test("one NAT gateway serving private subnets in two AZs → warning", () => {
    const ctx = makeCtx({
      Resources: {
        Vpc: { Type: "AWS::EC2::VPC", Properties: { CidrBlock: "10.0.0.0/16" } },
        PublicSubnetA: { Type: "AWS::EC2::Subnet", Properties: { VpcId: { Ref: "Vpc" }, CidrBlock: "10.0.0.0/24", AvailabilityZone: "us-east-1a" } },
        NatGateway: { Type: "AWS::EC2::NatGateway", Properties: { SubnetId: { Ref: "PublicSubnetA" } } },

        PrivateSubnetA: { Type: "AWS::EC2::Subnet", Properties: { VpcId: { Ref: "Vpc" }, CidrBlock: "10.0.1.0/24", AvailabilityZone: "us-east-1a" } },
        PrivateRouteTableA: { Type: "AWS::EC2::RouteTable", Properties: { VpcId: { Ref: "Vpc" } } },
        PrivateAssocA: { Type: "AWS::EC2::SubnetRouteTableAssociation", Properties: { SubnetId: { Ref: "PrivateSubnetA" }, RouteTableId: { Ref: "PrivateRouteTableA" } } },
        PrivateDefaultRouteA: { Type: "AWS::EC2::Route", Properties: { RouteTableId: { Ref: "PrivateRouteTableA" }, DestinationCidrBlock: "0.0.0.0/0", NatGatewayId: { Ref: "NatGateway" } } },

        PrivateSubnetB: { Type: "AWS::EC2::Subnet", Properties: { VpcId: { Ref: "Vpc" }, CidrBlock: "10.0.2.0/24", AvailabilityZone: "us-east-1b" } },
        PrivateRouteTableB: { Type: "AWS::EC2::RouteTable", Properties: { VpcId: { Ref: "Vpc" } } },
        PrivateAssocB: { Type: "AWS::EC2::SubnetRouteTableAssociation", Properties: { SubnetId: { Ref: "PrivateSubnetB" }, RouteTableId: { Ref: "PrivateRouteTableB" } } },
        PrivateDefaultRouteB: { Type: "AWS::EC2::Route", Properties: { RouteTableId: { Ref: "PrivateRouteTableB" }, DestinationCidrBlock: "0.0.0.0/0", NatGatewayId: { Ref: "NatGateway" } } },
      },
    });
    const diags = checkNatGatewaySingleAz(ctx);
    expect(diags).toHaveLength(1);
    expect(diags[0].checkId).toBe("WAW067");
    expect(diags[0].severity).toBe("warning");
    expect(diags[0].entity).toBe("NatGateway");
    expect(diags[0].message).toContain("us-east-1a");
    expect(diags[0].message).toContain("us-east-1b");
  });

  test("one NAT gateway per AZ, each serving only its own AZ's subnets → no diagnostic", () => {
    const ctx = makeCtx({
      Resources: {
        Vpc: { Type: "AWS::EC2::VPC", Properties: { CidrBlock: "10.0.0.0/16" } },

        PublicSubnetA: { Type: "AWS::EC2::Subnet", Properties: { VpcId: { Ref: "Vpc" }, CidrBlock: "10.0.0.0/24", AvailabilityZone: "us-east-1a" } },
        NatGatewayA: { Type: "AWS::EC2::NatGateway", Properties: { SubnetId: { Ref: "PublicSubnetA" } } },
        PrivateSubnetA: { Type: "AWS::EC2::Subnet", Properties: { VpcId: { Ref: "Vpc" }, CidrBlock: "10.0.1.0/24", AvailabilityZone: "us-east-1a" } },
        PrivateRouteTableA: { Type: "AWS::EC2::RouteTable", Properties: { VpcId: { Ref: "Vpc" } } },
        PrivateAssocA: { Type: "AWS::EC2::SubnetRouteTableAssociation", Properties: { SubnetId: { Ref: "PrivateSubnetA" }, RouteTableId: { Ref: "PrivateRouteTableA" } } },
        PrivateDefaultRouteA: { Type: "AWS::EC2::Route", Properties: { RouteTableId: { Ref: "PrivateRouteTableA" }, DestinationCidrBlock: "0.0.0.0/0", NatGatewayId: { Ref: "NatGatewayA" } } },

        PublicSubnetB: { Type: "AWS::EC2::Subnet", Properties: { VpcId: { Ref: "Vpc" }, CidrBlock: "10.0.10.0/24", AvailabilityZone: "us-east-1b" } },
        NatGatewayB: { Type: "AWS::EC2::NatGateway", Properties: { SubnetId: { Ref: "PublicSubnetB" } } },
        PrivateSubnetB: { Type: "AWS::EC2::Subnet", Properties: { VpcId: { Ref: "Vpc" }, CidrBlock: "10.0.2.0/24", AvailabilityZone: "us-east-1b" } },
        PrivateRouteTableB: { Type: "AWS::EC2::RouteTable", Properties: { VpcId: { Ref: "Vpc" } } },
        PrivateAssocB: { Type: "AWS::EC2::SubnetRouteTableAssociation", Properties: { SubnetId: { Ref: "PrivateSubnetB" }, RouteTableId: { Ref: "PrivateRouteTableB" } } },
        PrivateDefaultRouteB: { Type: "AWS::EC2::Route", Properties: { RouteTableId: { Ref: "PrivateRouteTableB" }, DestinationCidrBlock: "0.0.0.0/0", NatGatewayId: { Ref: "NatGatewayB" } } },
      },
    });
    expect(checkNatGatewaySingleAz(ctx)).toHaveLength(0);
  });

  test("one NAT gateway serving only subnets in its own AZ → no diagnostic", () => {
    const ctx = makeCtx({
      Resources: {
        Vpc: { Type: "AWS::EC2::VPC", Properties: { CidrBlock: "10.0.0.0/16" } },
        PublicSubnetA: { Type: "AWS::EC2::Subnet", Properties: { VpcId: { Ref: "Vpc" }, CidrBlock: "10.0.0.0/24", AvailabilityZone: "us-east-1a" } },
        NatGateway: { Type: "AWS::EC2::NatGateway", Properties: { SubnetId: { Ref: "PublicSubnetA" } } },
        PrivateSubnetA: { Type: "AWS::EC2::Subnet", Properties: { VpcId: { Ref: "Vpc" }, CidrBlock: "10.0.1.0/24", AvailabilityZone: "us-east-1a" } },
        PrivateRouteTableA: { Type: "AWS::EC2::RouteTable", Properties: { VpcId: { Ref: "Vpc" } } },
        PrivateAssocA: { Type: "AWS::EC2::SubnetRouteTableAssociation", Properties: { SubnetId: { Ref: "PrivateSubnetA" }, RouteTableId: { Ref: "PrivateRouteTableA" } } },
        PrivateDefaultRouteA: { Type: "AWS::EC2::Route", Properties: { RouteTableId: { Ref: "PrivateRouteTableA" }, DestinationCidrBlock: "0.0.0.0/0", NatGatewayId: { Ref: "NatGateway" } } },
      },
    });
    expect(checkNatGatewaySingleAz(ctx)).toHaveLength(0);
  });
});
