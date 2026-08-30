import { describe, test, expect } from "vitest";
import { createPostSynthContext } from "@intentius/chant-test-utils";
import { waw064, checkTgwBlackholeRoute } from "./waw064";

function makeCtx(template: object) {
  return createPostSynthContext({ aws: template });
}

describe("WAW064: Transit Gateway Route Table Declares A Blackhole Route", () => {
  test("check metadata", () => {
    expect(waw064.id).toBe("WAW064");
    expect(waw064.description).toContain("Blackhole");
  });

  test("TransitGatewayRoute with Blackhole: true → warning", () => {
    const ctx = makeCtx({
      Resources: {
        QuarantineRoute: {
          Type: "AWS::EC2::TransitGatewayRoute",
          Properties: {
            TransitGatewayRouteTableId: { Ref: "TgwRouteTable" },
            DestinationCidrBlock: "10.99.0.0/16",
            Blackhole: true,
          },
        },
        TgwRouteTable: { Type: "AWS::EC2::TransitGatewayRouteTable", Properties: { TransitGatewayId: { Ref: "Tgw" } } },
        Tgw: { Type: "AWS::EC2::TransitGateway", Properties: {} },
      },
    });
    const diags = checkTgwBlackholeRoute(ctx);
    expect(diags).toHaveLength(1);
    expect(diags[0].checkId).toBe("WAW064");
    expect(diags[0].severity).toBe("warning");
    expect(diags[0].entity).toBe("QuarantineRoute");
    expect(diags[0].message).toContain("10.99.0.0/16");
    expect(diags[0].lexicon).toBe("aws");
  });

  test("normal TransitGatewayRoute forwarding to an attachment → no diagnostic", () => {
    const ctx = makeCtx({
      Resources: {
        SpokeRoute: {
          Type: "AWS::EC2::TransitGatewayRoute",
          Properties: {
            TransitGatewayRouteTableId: { Ref: "TgwRouteTable" },
            DestinationCidrBlock: "10.0.1.0/24",
            TransitGatewayAttachmentId: { Ref: "SpokeAttachment" },
          },
        },
        TgwRouteTable: { Type: "AWS::EC2::TransitGatewayRouteTable", Properties: { TransitGatewayId: { Ref: "Tgw" } } },
        Tgw: { Type: "AWS::EC2::TransitGateway", Properties: {} },
        SpokeAttachment: { Type: "AWS::EC2::TransitGatewayVpcAttachment", Properties: {} },
      },
    });
    expect(checkTgwBlackholeRoute(ctx)).toHaveLength(0);
  });

  test("Blackhole: false is not flagged", () => {
    const ctx = makeCtx({
      Resources: {
        SpokeRoute: {
          Type: "AWS::EC2::TransitGatewayRoute",
          Properties: {
            TransitGatewayRouteTableId: { Ref: "TgwRouteTable" },
            DestinationCidrBlock: "10.0.1.0/24",
            TransitGatewayAttachmentId: { Ref: "SpokeAttachment" },
            Blackhole: false,
          },
        },
      },
    });
    expect(checkTgwBlackholeRoute(ctx)).toHaveLength(0);
  });

  test("no TransitGatewayRoute resources → no diagnostic", () => {
    const ctx = makeCtx({ Resources: { Vpc: { Type: "AWS::EC2::VPC", Properties: { CidrBlock: "10.0.0.0/16" } } } });
    expect(checkTgwBlackholeRoute(ctx)).toHaveLength(0);
  });
});
