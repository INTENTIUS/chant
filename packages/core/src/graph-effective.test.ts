import { describe, it, expect } from "vitest";
import { enrichEffectiveTopology } from "./graph-effective";
import type { GraphIR } from "./graph-ir";

function node(id: string, kind: string, attrs: Record<string, unknown> = {}) {
  return { id, kind: `AWS::EC2::${kind}`, attrs };
}
const sshRule = { IpProtocol: "tcp", FromPort: 22, ToPort: 22, CidrIp: "0.0.0.0/0" };

/**
 * webServer:  direct SG with SSH-open, subnet routes to an IGW  → SSH-reachable
 * ltServer:   SG via LAUNCH TEMPLATE, same public subnet        → SSH-reachable (the CLI-missed hop)
 * westServer: public subnet (IGW) but its SG has NO ingress     → internet-facing, not SSH-open
 * privServer: private subnet (no IGW route)                     → not internet-facing
 */
const ir: GraphIR = {
  nodes: [
    node("webServer", "Instance"),
    node("ltServer", "Instance"),
    node("westServer", "Instance"),
    node("privServer", "Instance"),
    node("webSg", "SecurityGroup", { SecurityGroupIngress: [sshRule, { IpProtocol: "tcp", FromPort: 80, ToPort: 80, CidrIp: "0.0.0.0/0" }] }),
    node("westSg", "SecurityGroup", { SecurityGroupIngress: [] }),
    node("lt", "LaunchTemplate"),
    node("pubSubnet", "Subnet"),
    node("westSubnet", "Subnet"),
    node("privSubnet", "Subnet"),
    node("pubRt", "RouteTable"),
    node("westRt", "RouteTable"),
    node("pubAssoc", "SubnetRouteTableAssociation"),
    node("westAssoc", "SubnetRouteTableAssociation"),
    node("pubRoute", "Route", { DestinationCidrBlock: "0.0.0.0/0" }),
    node("westRoute", "Route", { DestinationCidrBlock: "0.0.0.0/0" }),
    node("igw", "InternetGateway"),
    node("westIgw", "InternetGateway"),
  ] as never,
  edges: [
    { from: "webServer", to: "webSg", viaAttr: "SecurityGroupIds" },
    { from: "webServer", to: "pubSubnet", viaAttr: "SubnetId" },
    { from: "ltServer", to: "lt", viaAttr: "LaunchTemplate" },
    { from: "lt", to: "webSg", viaAttr: "LaunchTemplateData" },
    { from: "ltServer", to: "pubSubnet", viaAttr: "SubnetId" },
    { from: "westServer", to: "westSg", viaAttr: "SecurityGroupIds" },
    { from: "westServer", to: "westSubnet", viaAttr: "SubnetId" },
    { from: "privServer", to: "privSubnet", viaAttr: "SubnetId" },
    { from: "pubAssoc", to: "pubSubnet", viaAttr: "SubnetId" },
    { from: "pubAssoc", to: "pubRt", viaAttr: "RouteTableId" },
    { from: "pubRoute", to: "pubRt", viaAttr: "RouteTableId" },
    { from: "pubRoute", to: "igw", viaAttr: "GatewayId" },
    { from: "westAssoc", to: "westSubnet", viaAttr: "SubnetId" },
    { from: "westAssoc", to: "westRt", viaAttr: "RouteTableId" },
    { from: "westRoute", to: "westRt", viaAttr: "RouteTableId" },
    { from: "westRoute", to: "westIgw", viaAttr: "GatewayId" },
  ] as never,
  groups: {},
};

describe("enrichEffectiveTopology", () => {
  const enriched = enrichEffectiveTopology(ir);
  const attrs = (id: string) => enriched.nodes.find((n) => n.id === id)!.attrs as Record<string, unknown>;

  it("resolves the security group reached VIA a launch template (the CLI-missed hop)", () => {
    expect(attrs("ltServer").effectiveIngress).toContain("tcp:22:0.0.0.0/0");
  });

  it("resolves a direct security group", () => {
    expect(attrs("webServer").effectiveIngress).toContain("tcp:22:0.0.0.0/0");
  });

  it("marks instances whose subnet routes to an IGW as internetFacing", () => {
    expect(attrs("webServer").internetFacing).toBe(true);
    expect(attrs("ltServer").internetFacing).toBe(true);
    expect(attrs("westServer").internetFacing).toBe(true);
    expect(attrs("privServer").internetFacing).toBe(false);
  });

  it("keeps a live-supplied internetFacing (e.g. default VPC) even with no declared route", () => {
    // A live enrichment marks an instance internetFacing; its subnet's routing
    // is not in the declared graph (the account's default VPC). Enrichment
    // must NOT overwrite that truth back to false.
    const withLive: GraphIR = {
      nodes: [node("defaultVpcServer", "Instance", { internetFacing: true })] as never,
      edges: [] as never,
      groups: {},
    };
    const out = enrichEffectiveTopology(withLive);
    expect((out.nodes[0].attrs as Record<string, unknown>).internetFacing).toBe(true);
  });

  it("SSH-reachable = internetFacing AND effectiveIngress tcp:22:0.0.0.0/0 → only web + lt", () => {
    const reachable = enriched.nodes.filter(
      (n) => (n.attrs as Record<string, unknown>).internetFacing === true &&
        ((n.attrs as Record<string, unknown>).effectiveIngress as string[] | undefined)?.includes("tcp:22:0.0.0.0/0"),
    );
    expect(reachable.map((n) => n.id).sort()).toEqual(["ltServer", "webServer"]);
  });
});
