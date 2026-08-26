/**
 * WAW066: Private Subnet Route Table Has No Working Default Route
 *
 * Cross-resource join: a subnet's outbound path depends on a chain of three
 * independently-declared resources — the `AWS::EC2::SubnetRouteTableAssociation`
 * that pins it to a route table, the `AWS::EC2::Route` on that table for
 * `0.0.0.0/0`, and the gateway that route names. CloudFormation validates
 * none of this end-to-end: a subnet can be wired to a route table with no
 * default route at all, or with a default route whose NAT gateway / Transit
 * Gateway target was renamed or removed elsewhere in the template, and the
 * stack still deploys clean. The subnet is black-holed — every deploy
 * succeeds, and the only symptom is a workload with no outbound connectivity.
 *
 * A route table with a default route to an `AWS::EC2::InternetGateway` is
 * treated as a public subnet and is out of scope for this check — this rule
 * only flags the private case: no default route, or one whose target
 * (`NatGatewayId` / `TransitGatewayId` / etc.) does not resolve to a
 * resource declared in the same template. A route naming a target that
 * exists in the template resolves cleanly and is never flagged, per the
 * cross-resource contract.
 */

import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
import { parseCFTemplate, findResourceRefs, type CFResource, type CFTemplate } from "./cf-refs";

type RouteClass = "public" | "resolved" | "dangling";

const OTHER_TARGET_KEYS = [
  "NatGatewayId",
  "TransitGatewayId",
  "VpcPeeringConnectionId",
  "EgressOnlyInternetGatewayId",
  "LocalGatewayId",
  "CarrierGatewayId",
  "NetworkInterfaceId",
  "InstanceId",
] as const;

/** Classify a `0.0.0.0/0` Route's target. A target Ref that exists always resolves. */
function classifyDefaultRoute(route: CFResource, resources: Record<string, CFResource>): RouteClass {
  const props = route.Properties ?? {};

  if (props.GatewayId !== undefined) {
    if (typeof props.GatewayId === "string") {
      return props.GatewayId.startsWith("igw-") ? "public" : "resolved";
    }
    const refs = findResourceRefs(props.GatewayId);
    if (refs.size !== 1) return "resolved"; // unprovable intrinsic — stay quiet
    const [id] = refs;
    if (!resources[id]) return "dangling";
    return resources[id].Type === "AWS::EC2::InternetGateway" ? "public" : "resolved";
  }

  for (const key of OTHER_TARGET_KEYS) {
    const value = (props as Record<string, unknown>)[key];
    if (value === undefined) continue;
    if (typeof value === "string") return "resolved"; // literal id from outside the template
    const refs = findResourceRefs(value);
    if (refs.size !== 1) return "resolved";
    const [id] = refs;
    return resources[id] ? "resolved" : "dangling";
  }

  return "resolved"; // no recognized target key — can't classify, stay quiet
}

function isDefaultRoute(route: CFResource): boolean {
  return route.Properties?.DestinationCidrBlock === "0.0.0.0/0";
}

export function checkPrivateSubnetDefaultRoute(ctx: PostSynthContext): PostSynthDiagnostic[] {
  const diagnostics: PostSynthDiagnostic[] = [];

  for (const [_lexicon, output] of ctx.outputs) {
    const template: CFTemplate | null = parseCFTemplate(output);
    if (!template?.Resources) continue;
    const resources = template.Resources;

    // subnetId -> Set<routeTableId>, from explicit associations only.
    const subnetRouteTables = new Map<string, Set<string>>();
    for (const resource of Object.values(resources)) {
      if (resource.Type !== "AWS::EC2::SubnetRouteTableAssociation") continue;
      const props = resource.Properties ?? {};
      const subnetRefs = findResourceRefs(props.SubnetId);
      const rtRefs = findResourceRefs(props.RouteTableId);
      for (const subnetId of subnetRefs) {
        let set = subnetRouteTables.get(subnetId);
        if (!set) {
          set = new Set();
          subnetRouteTables.set(subnetId, set);
        }
        for (const rtId of rtRefs) set.add(rtId);
      }
    }

    // routeTableId -> Route resources targeting it.
    const routesByTable = new Map<string, CFResource[]>();
    for (const resource of Object.values(resources)) {
      if (resource.Type !== "AWS::EC2::Route") continue;
      for (const rtId of findResourceRefs(resource.Properties?.RouteTableId)) {
        let list = routesByTable.get(rtId);
        if (!list) {
          list = [];
          routesByTable.set(rtId, list);
        }
        list.push(resource);
      }
    }

    for (const [subnetId, rtIds] of subnetRouteTables) {
      if (resources[subnetId]?.Type !== "AWS::EC2::Subnet") continue;

      for (const rtId of rtIds) {
        if (resources[rtId]?.Type !== "AWS::EC2::RouteTable") continue;

        const routes = routesByTable.get(rtId) ?? [];
        const defaultRoutes = routes.filter(isDefaultRoute);

        if (defaultRoutes.length === 0) {
          diagnostics.push({
            checkId: "WAW066",
            severity: "warning",
            message: `Subnet "${subnetId}" is associated with route table "${rtId}", which has no default route (0.0.0.0/0) — outbound traffic from this subnet has no path out, black-holed by omission`,
            entity: subnetId,
            lexicon: "aws",
          });
          continue;
        }

        const classes = defaultRoutes.map((route) => classifyDefaultRoute(route, resources));
        if (classes.includes("public")) continue; // has a real IGW default route — public subnet, out of scope
        if (classes.every((c) => c === "dangling")) {
          diagnostics.push({
            checkId: "WAW066",
            severity: "error",
            message: `Subnet "${subnetId}"'s route table "${rtId}" has a default route (0.0.0.0/0) whose target does not exist in this template — outbound traffic from this subnet is black-holed`,
            entity: subnetId,
            lexicon: "aws",
          });
        }
      }
    }
  }

  return diagnostics;
}

export const waw066: PostSynthCheck = {
  id: "WAW066",
  description: "Private subnet's route table has no default route, or its default route targets a gateway that does not exist in the template",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    return checkPrivateSubnetDefaultRoute(ctx);
  },
};
