/**
 * WAW065: Transit Gateway Route Table Wiring Is Incomplete
 *
 * A Transit Gateway route table only does anything once two independent
 * pieces are both wired up: an `AWS::EC2::TransitGatewayRouteTableAssociation`
 * (which attachment's traffic is evaluated against this table) and an
 * `AWS::EC2::TransitGatewayRouteTablePropagation` (which attachments' routes
 * populate it). CloudFormation is happy to deploy a route table with one but
 * not the other — the stack succeeds, and the gap only shows up as traffic
 * that can't find a route. Two patterns, both "declared but half-wired":
 *
 *  - a route table has one or more associations but zero propagations — the
 *    associated attachment's traffic is evaluated against this table, but
 *    nothing ever populates it with routes;
 *  - a declared attachment (VPC/VPN/peering, or the generic
 *    TransitGatewayAttachment) is referenced by neither an association nor
 *    a propagation anywhere in the template — it hangs off the transit
 *    gateway with no route table wiring at all.
 */

import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
import { parseCFTemplate, findResourceRefs } from "./cf-refs";

const ATTACHMENT_TYPES = new Set([
  "AWS::EC2::TransitGatewayAttachment",
  "AWS::EC2::TransitGatewayVpcAttachment",
  "AWS::EC2::TransitGatewayVpnAttachment",
  "AWS::EC2::TransitGatewayPeeringAttachment",
]);

export function checkTgwRouteTableWiring(ctx: PostSynthContext): PostSynthDiagnostic[] {
  const diagnostics: PostSynthDiagnostic[] = [];

  for (const [_lexicon, output] of ctx.outputs) {
    const template = parseCFTemplate(output);
    if (!template?.Resources) continue;
    const resources = template.Resources;

    const routeTableIds = new Set<string>();
    const attachmentIds = new Set<string>();
    for (const [logicalId, resource] of Object.entries(resources)) {
      if (resource.Type === "AWS::EC2::TransitGatewayRouteTable") routeTableIds.add(logicalId);
      if (ATTACHMENT_TYPES.has(resource.Type)) attachmentIds.add(logicalId);
    }
    if (routeTableIds.size === 0 && attachmentIds.size === 0) continue;

    const associationsByTable = new Map<string, Set<string>>();
    const propagationsByTable = new Map<string, Set<string>>();
    const referencedAttachments = new Set<string>();

    for (const resource of Object.values(resources)) {
      let bucket: Map<string, Set<string>> | null = null;
      if (resource.Type === "AWS::EC2::TransitGatewayRouteTableAssociation") bucket = associationsByTable;
      if (resource.Type === "AWS::EC2::TransitGatewayRouteTablePropagation") bucket = propagationsByTable;
      if (!bucket) continue;

      const props = resource.Properties ?? {};
      const attachmentRefs = findResourceRefs(props.TransitGatewayAttachmentId);
      for (const attId of attachmentRefs) referencedAttachments.add(attId);

      for (const rtId of findResourceRefs(props.TransitGatewayRouteTableId)) {
        let attSet = bucket.get(rtId);
        if (!attSet) {
          attSet = new Set();
          bucket.set(rtId, attSet);
        }
        for (const attId of attachmentRefs) attSet.add(attId);
      }
    }

    // Pattern A: associated but never propagated.
    for (const rtId of routeTableIds) {
      const associations = associationsByTable.get(rtId);
      const propagations = propagationsByTable.get(rtId);
      if (associations && associations.size > 0 && (!propagations || propagations.size === 0)) {
        diagnostics.push({
          checkId: "WAW065",
          severity: "warning",
          message: `TransitGatewayRouteTable "${rtId}" has ${associations.size} association(s) but no route propagations — the associated attachment's routes never populate this table, likely incomplete wiring`,
          entity: rtId,
          lexicon: "aws",
        });
      }
    }

    // Pattern B: a declared attachment wired into no route table at all.
    for (const attId of attachmentIds) {
      if (!referencedAttachments.has(attId)) {
        diagnostics.push({
          checkId: "WAW065",
          severity: "warning",
          message: `Transit Gateway attachment "${attId}" is referenced by no TransitGatewayRouteTableAssociation or TransitGatewayRouteTablePropagation — it has no route table wiring, so nothing can route to or from it`,
          entity: attId,
          lexicon: "aws",
        });
      }
    }
  }

  return diagnostics;
}

export const waw065: PostSynthCheck = {
  id: "WAW065",
  description: "Transit Gateway route table has associations but no propagations, or an attachment wired into no route table",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    return checkTgwRouteTableWiring(ctx);
  },
};
