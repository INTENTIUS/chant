import { describe, test, expect } from "vitest";
import { createPostSynthContext } from "@intentius/chant-test-utils";
import { waw068, checkVpnGatewayRedundancy } from "./waw068";

function makeCtx(template: object) {
  return createPostSynthContext({ aws: template });
}

describe("WAW068: VPN Gateway Has A Single VPN Connection", () => {
  test("check metadata", () => {
    expect(waw068.id).toBe("WAW068");
    expect(waw068.description).toContain("VPN Connection");
  });

  test("VPN Gateway with a single VPN connection → warning", () => {
    const ctx = makeCtx({
      Resources: {
        Vgw: { Type: "AWS::EC2::VPNGateway", Properties: { Type: "ipsec.1" } },
        CustomerGw: { Type: "AWS::EC2::CustomerGateway", Properties: { Type: "ipsec.1", BgpAsn: 65000, IpAddress: "203.0.113.1" } },
        VpnConnection: {
          Type: "AWS::EC2::VPNConnection",
          Properties: { Type: "ipsec.1", CustomerGatewayId: { Ref: "CustomerGw" }, VpnGatewayId: { Ref: "Vgw" } },
        },
      },
    });
    const diags = checkVpnGatewayRedundancy(ctx);
    expect(diags).toHaveLength(1);
    expect(diags[0].checkId).toBe("WAW068");
    expect(diags[0].severity).toBe("warning");
    expect(diags[0].entity).toBe("Vgw");
    expect(diags[0].message).toContain("VpnConnection");
  });

  test("Transit Gateway with a single VPN connection → warning", () => {
    const ctx = makeCtx({
      Resources: {
        Tgw: { Type: "AWS::EC2::TransitGateway", Properties: {} },
        CustomerGw: { Type: "AWS::EC2::CustomerGateway", Properties: { Type: "ipsec.1", BgpAsn: 65000, IpAddress: "203.0.113.1" } },
        VpnConnection: {
          Type: "AWS::EC2::VPNConnection",
          Properties: { Type: "ipsec.1", CustomerGatewayId: { Ref: "CustomerGw" }, TransitGatewayId: { Ref: "Tgw" } },
        },
      },
    });
    const diags = checkVpnGatewayRedundancy(ctx);
    expect(diags).toHaveLength(1);
    expect(diags[0].entity).toBe("Tgw");
    expect(diags[0].message).toContain("Transit Gateway");
  });

  test("VPN Gateway with two VPN connections attached → no diagnostic", () => {
    const ctx = makeCtx({
      Resources: {
        Vgw: { Type: "AWS::EC2::VPNGateway", Properties: { Type: "ipsec.1" } },
        CustomerGwA: { Type: "AWS::EC2::CustomerGateway", Properties: { Type: "ipsec.1", BgpAsn: 65000, IpAddress: "203.0.113.1" } },
        CustomerGwB: { Type: "AWS::EC2::CustomerGateway", Properties: { Type: "ipsec.1", BgpAsn: 65000, IpAddress: "203.0.113.2" } },
        VpnConnectionA: {
          Type: "AWS::EC2::VPNConnection",
          Properties: { Type: "ipsec.1", CustomerGatewayId: { Ref: "CustomerGwA" }, VpnGatewayId: { Ref: "Vgw" } },
        },
        VpnConnectionB: {
          Type: "AWS::EC2::VPNConnection",
          Properties: { Type: "ipsec.1", CustomerGatewayId: { Ref: "CustomerGwB" }, VpnGatewayId: { Ref: "Vgw" } },
        },
      },
    });
    expect(checkVpnGatewayRedundancy(ctx)).toHaveLength(0);
  });

  test("no VPN connections at all → no diagnostic", () => {
    const ctx = makeCtx({ Resources: { Vgw: { Type: "AWS::EC2::VPNGateway", Properties: { Type: "ipsec.1" } } } });
    expect(checkVpnGatewayRedundancy(ctx)).toHaveLength(0);
  });
});
