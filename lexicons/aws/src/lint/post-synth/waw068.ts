/**
 * WAW068: VPN Gateway Has A Single VPN Connection
 *
 * An `AWS::EC2::VPNConnection` always gets two tunnels from AWS, but that
 * redundancy only covers the tunnel pair inside one connection — it does
 * nothing if the connection's Customer Gateway, on-prem device, or the
 * single site it terminates at goes down. The reliability boundary that
 * matters is the connection itself: a `AWS::EC2::VPNGateway` (or a Transit
 * Gateway used for VPN attachment) with only one `VPNConnection` attached
 * has no fallback path for hybrid connectivity if that connection's
 * Customer Gateway or on-prem side fails.
 *
 * Cross-resource join: group every declared `VPNConnection` by the gateway
 * (`VpnGatewayId` or `TransitGatewayId`) it attaches to, and flag any
 * gateway left with exactly one.
 */

import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
import { parseCFTemplate, findResourceRefs, type CFTemplate } from "./cf-refs";

export function checkVpnGatewayRedundancy(ctx: PostSynthContext): PostSynthDiagnostic[] {
  const diagnostics: PostSynthDiagnostic[] = [];

  for (const [_lexicon, output] of ctx.outputs) {
    const template: CFTemplate | null = parseCFTemplate(output);
    if (!template?.Resources) continue;
    const resources = template.Resources;

    // gateway logical id -> the VPNConnection logical ids attached to it.
    const connectionsByGateway = new Map<string, string[]>();

    for (const [logicalId, resource] of Object.entries(resources)) {
      if (resource.Type !== "AWS::EC2::VPNConnection") continue;
      const props = resource.Properties ?? {};

      const gatewayProp = props.VpnGatewayId !== undefined ? props.VpnGatewayId : props.TransitGatewayId;
      if (gatewayProp === undefined) continue; // no declared gateway target — can't group, stay quiet

      const gwRefs = findResourceRefs(gatewayProp);
      if (gwRefs.size !== 1) continue;
      const [gwId] = gwRefs;

      const gw = resources[gwId];
      if (!gw || (gw.Type !== "AWS::EC2::VPNGateway" && gw.Type !== "AWS::EC2::TransitGateway")) continue;

      let list = connectionsByGateway.get(gwId);
      if (!list) {
        list = [];
        connectionsByGateway.set(gwId, list);
      }
      list.push(logicalId);
    }

    for (const [gwId, connectionIds] of connectionsByGateway) {
      if (connectionIds.length !== 1) continue;

      const kind = resources[gwId].Type === "AWS::EC2::VPNGateway" ? "VPN Gateway" : "Transit Gateway";
      diagnostics.push({
        checkId: "WAW068",
        severity: "warning",
        message: `${kind} "${gwId}" has only one VPN connection ("${connectionIds[0]}") attached — no redundant path if this connection, its tunnels, or its Customer Gateway fail; attach a second VPNConnection (ideally to a separate Customer Gateway) for hybrid-connectivity redundancy`,
        entity: gwId,
        lexicon: "aws",
      });
    }
  }

  return diagnostics;
}

export const waw068: PostSynthCheck = {
  id: "WAW068",
  description: "VPN Gateway or Transit Gateway has only one attached VPN Connection — no redundant path for hybrid connectivity",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    return checkVpnGatewayRedundancy(ctx);
  },
};
