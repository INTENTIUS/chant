import { describe, test, expect } from "vitest";
import { createPostSynthContext } from "@intentius/chant-test-utils";
import { waw065, checkTgwRouteTableWiring } from "./waw065";

function makeCtx(template: object) {
  return createPostSynthContext({ aws: template });
}

describe("WAW065: Transit Gateway Route Table Wiring Is Incomplete", () => {
  test("check metadata", () => {
    expect(waw065.id).toBe("WAW065");
    expect(waw065.description).toContain("propagation");
  });

  test("route table with an association but no propagation → warning", () => {
    const ctx = makeCtx({
      Resources: {
        Tgw: { Type: "AWS::EC2::TransitGateway", Properties: {} },
        SpokeRouteTable: { Type: "AWS::EC2::TransitGatewayRouteTable", Properties: { TransitGatewayId: { Ref: "Tgw" } } },
        SpokeAttachment: { Type: "AWS::EC2::TransitGatewayVpcAttachment", Properties: { TransitGatewayId: { Ref: "Tgw" } } },
        SpokeAssociation: {
          Type: "AWS::EC2::TransitGatewayRouteTableAssociation",
          Properties: { TransitGatewayAttachmentId: { Ref: "SpokeAttachment" }, TransitGatewayRouteTableId: { Ref: "SpokeRouteTable" } },
        },
      },
    });
    const diags = checkTgwRouteTableWiring(ctx);
    expect(diags).toHaveLength(1);
    expect(diags[0].checkId).toBe("WAW065");
    expect(diags[0].entity).toBe("SpokeRouteTable");
    expect(diags[0].message).toContain("no route propagations");
  });

  test("attachment referenced by neither an association nor a propagation → warning", () => {
    const ctx = makeCtx({
      Resources: {
        Tgw: { Type: "AWS::EC2::TransitGateway", Properties: {} },
        SpokeRouteTable: { Type: "AWS::EC2::TransitGatewayRouteTable", Properties: { TransitGatewayId: { Ref: "Tgw" } } },
        OrphanAttachment: { Type: "AWS::EC2::TransitGatewayVpcAttachment", Properties: { TransitGatewayId: { Ref: "Tgw" } } },
      },
    });
    const diags = checkTgwRouteTableWiring(ctx);
    expect(diags).toHaveLength(1);
    expect(diags[0].entity).toBe("OrphanAttachment");
    expect(diags[0].message).toContain("no route table wiring");
  });

  test("both patterns fire independently in the same template", () => {
    const ctx = makeCtx({
      Resources: {
        Tgw: { Type: "AWS::EC2::TransitGateway", Properties: {} },
        SpokeRouteTable: { Type: "AWS::EC2::TransitGatewayRouteTable", Properties: { TransitGatewayId: { Ref: "Tgw" } } },
        SpokeAttachment: { Type: "AWS::EC2::TransitGatewayVpcAttachment", Properties: { TransitGatewayId: { Ref: "Tgw" } } },
        SpokeAssociation: {
          Type: "AWS::EC2::TransitGatewayRouteTableAssociation",
          Properties: { TransitGatewayAttachmentId: { Ref: "SpokeAttachment" }, TransitGatewayRouteTableId: { Ref: "SpokeRouteTable" } },
        },
        OrphanAttachment: { Type: "AWS::EC2::TransitGatewayVpnAttachment", Properties: { TransitGatewayId: { Ref: "Tgw" } } },
      },
    });
    const diags = checkTgwRouteTableWiring(ctx);
    expect(diags).toHaveLength(2);
    const entities = diags.map((d) => d.entity).sort();
    expect(entities).toEqual(["OrphanAttachment", "SpokeRouteTable"]);
  });

  test("route table with both an association and a propagation, attachment referenced by both → no diagnostic", () => {
    const ctx = makeCtx({
      Resources: {
        Tgw: { Type: "AWS::EC2::TransitGateway", Properties: {} },
        SpokeRouteTable: { Type: "AWS::EC2::TransitGatewayRouteTable", Properties: { TransitGatewayId: { Ref: "Tgw" } } },
        SpokeAttachment: { Type: "AWS::EC2::TransitGatewayVpcAttachment", Properties: { TransitGatewayId: { Ref: "Tgw" } } },
        SpokeAssociation: {
          Type: "AWS::EC2::TransitGatewayRouteTableAssociation",
          Properties: { TransitGatewayAttachmentId: { Ref: "SpokeAttachment" }, TransitGatewayRouteTableId: { Ref: "SpokeRouteTable" } },
        },
        SpokePropagation: {
          Type: "AWS::EC2::TransitGatewayRouteTablePropagation",
          Properties: { TransitGatewayAttachmentId: { Ref: "SpokeAttachment" }, TransitGatewayRouteTableId: { Ref: "SpokeRouteTable" } },
        },
      },
    });
    expect(checkTgwRouteTableWiring(ctx)).toHaveLength(0);
  });

  test("no transit gateway resources at all → no diagnostic", () => {
    const ctx = makeCtx({ Resources: { Vpc: { Type: "AWS::EC2::VPC", Properties: { CidrBlock: "10.0.0.0/16" } } } });
    expect(checkTgwRouteTableWiring(ctx)).toHaveLength(0);
  });
});
