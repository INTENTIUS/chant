/**
 * WAW067: Single-AZ NAT Gateway Serves Multi-AZ Private Subnets
 *
 * Cross-resource join across four resource kinds: a NAT gateway lives in one
 * subnet, which lives in one Availability Zone; a route table's default
 * route names the NAT gateway it forwards to; a subnet is pinned to a route
 * table by an `AWS::EC2::SubnetRouteTableAssociation`. Follow that chain and
 * a common reliability gap falls out — private subnets in two or more AZs
 * all defaulting to the *same* NAT gateway. CloudFormation has no opinion on
 * this; it deploys cleanly. But a NAT gateway lives entirely inside one AZ,
 * so if that AZ has an outage, every subnet depending on it loses egress —
 * including the subnets in AZs that were otherwise healthy. The
 * Well-Architected fix is one NAT gateway per AZ, each serving only its own
 * AZ's subnets.
 *
 * Only fires when the Availability Zones involved are literal strings —
 * an `Fn::GetAZs`/`Fn::Select`-derived AZ can't be compared statically, so a
 * subnet without a literal `AvailabilityZone` is silently excluded rather
 * than guessed at.
 */

import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
import { parseCFTemplate, findResourceRefs, type CFTemplate } from "./cf-refs";

export function checkNatGatewaySingleAz(ctx: PostSynthContext): PostSynthDiagnostic[] {
  const diagnostics: PostSynthDiagnostic[] = [];

  for (const [_lexicon, output] of ctx.outputs) {
    const template: CFTemplate | null = parseCFTemplate(output);
    if (!template?.Resources) continue;
    const resources = template.Resources;

    // NAT gateway id -> its own subnet's literal AZ.
    const natGatewayAz = new Map<string, string>();
    for (const [logicalId, resource] of Object.entries(resources)) {
      if (resource.Type !== "AWS::EC2::NatGateway") continue;
      const subnetRefs = findResourceRefs(resource.Properties?.SubnetId);
      if (subnetRefs.size !== 1) continue;
      const [subnetId] = subnetRefs;
      const az = resources[subnetId]?.Properties?.AvailabilityZone;
      if (typeof az === "string") natGatewayAz.set(logicalId, az);
    }
    if (natGatewayAz.size === 0) continue;

    // route table id -> the NAT gateway its default route forwards to.
    const routeTableNatTarget = new Map<string, string>();
    for (const resource of Object.values(resources)) {
      if (resource.Type !== "AWS::EC2::Route") continue;
      const props = resource.Properties ?? {};
      if (props.DestinationCidrBlock !== "0.0.0.0/0") continue;
      const natRefs = findResourceRefs(props.NatGatewayId);
      if (natRefs.size !== 1) continue;
      const [natId] = natRefs;
      if (!natGatewayAz.has(natId)) continue;
      for (const rtId of findResourceRefs(props.RouteTableId)) {
        routeTableNatTarget.set(rtId, natId);
      }
    }

    // subnet id -> route table id, from explicit associations only.
    const subnetRouteTable = new Map<string, string>();
    for (const resource of Object.values(resources)) {
      if (resource.Type !== "AWS::EC2::SubnetRouteTableAssociation") continue;
      const props = resource.Properties ?? {};
      const subnetRefs = findResourceRefs(props.SubnetId);
      const rtRefs = findResourceRefs(props.RouteTableId);
      if (subnetRefs.size !== 1 || rtRefs.size !== 1) continue;
      const [subnetId] = subnetRefs;
      const [rtId] = rtRefs;
      subnetRouteTable.set(subnetId, rtId);
    }

    // NAT gateway id -> the set of subnets that default-route through it.
    const servedSubnets = new Map<string, Set<string>>();
    for (const [subnetId, rtId] of subnetRouteTable) {
      const natId = routeTableNatTarget.get(rtId);
      if (!natId) continue;
      let set = servedSubnets.get(natId);
      if (!set) {
        set = new Set();
        servedSubnets.set(natId, set);
      }
      set.add(subnetId);
    }

    for (const [natId, subnetIds] of servedSubnets) {
      const azs = new Set<string>();
      for (const subnetId of subnetIds) {
        const az = resources[subnetId]?.Properties?.AvailabilityZone;
        if (typeof az === "string") azs.add(az);
      }
      if (azs.size > 1) {
        diagnostics.push({
          checkId: "WAW067",
          severity: "warning",
          message: `NAT Gateway "${natId}" (in ${natGatewayAz.get(natId)}) is the default-route egress for private subnets across ${azs.size} Availability Zones (${[...azs].sort().join(", ")}) — a single-AZ NAT gateway is a single point of failure for cross-AZ egress; add one NAT gateway per AZ`,
          entity: natId,
          lexicon: "aws",
        });
      }
    }
  }

  return diagnostics;
}

export const waw067: PostSynthCheck = {
  id: "WAW067",
  description: "A single-AZ NAT gateway serves private subnets across multiple Availability Zones — single point of failure for cross-AZ egress",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    return checkNatGatewaySingleAz(ctx);
  },
};
