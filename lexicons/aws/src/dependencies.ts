/**
 * What an AWS estate depends on but does not declare (#1273).
 *
 * `describeResources` is scoped to the stack. An instance placed in the
 * account's default VPC routes through a route table nobody declared, so that
 * table is never observed, never a node, and no fold can traverse to it. The
 * answer used to be computed inside the lexicon and injected as an attribute —
 * which is a conclusion no snapshot can record enough to recompute.
 *
 * This reports the resources instead, so the one graph fold derives the answer.
 *
 * The closure is bounded: start from the observed instances, follow the
 * reference chain the catalog declares as meaningful — subnet, then route
 * table, then gateway — and stop. Anything not reached from a declared resource
 * along a declared reference is not a dependency, it is just the account.
 */

import { applyAwsEndpointArgv } from "./components/cloud-executor";
import type { DependencyObservation, ResourceMetadata, IREdge } from "@intentius/chant/lexicon";

/** Cloud-shaped ids are stable across a redeploy and unique per account. */
const nodeId = (physicalId: string): string => physicalId;

interface RawRouteTable {
  RouteTableId?: string;
  VpcId?: string;
  Routes?: Array<{ GatewayId?: string; DestinationCidrBlock?: string }>;
  Associations?: Array<{ SubnetId?: string; Main?: boolean }>;
}

/**
 * Read the routing an observed estate depends on.
 *
 * Only the tables that actually serve an observed instance are reported: one
 * reached by an explicit subnet association, or the VPC's main table standing in
 * for a subnet with none. A route table serving nothing chant deployed is not a
 * dependency of this estate.
 */
export async function observeAwsDependencies(options: {
  observed: Record<string, ResourceMetadata>;
  region?: string;
}): Promise<DependencyObservation> {
  const { getRuntime } = await import("@intentius/chant/runtime-adapter");
  const rt = getRuntime();
  const regionArgs = options.region ? ["--region", options.region] : [];
  const run = (args: string[]) =>
    rt.spawn(applyAwsEndpointArgv(["aws", ...args, ...regionArgs, "--output", "json"], process.env.AWS_ENDPOINT_URL));

  const resources: Record<string, ResourceMetadata> = {};
  const edges: IREdge[] = [];

  // Roots: the instances this estate manages, and where each one sits. Placement
  // comes from the live API rather than the template, because the declared side
  // may only carry a parameter reference to a subnet it never modelled.
  const instances = Object.entries(options.observed).filter(
    ([, meta]) => meta.type === "AWS::EC2::Instance" && meta.physicalId,
  );
  if (instances.length === 0) return { resources: {}, edges: [] };

  try {
    const described = await run([
      "ec2",
      "describe-instances",
      "--instance-ids",
      ...instances.map(([, meta]) => meta.physicalId as string),
    ]);
    if (described.exitCode !== 0) return { resources: {}, edges: [] };

    const placement = new Map<string, { subnetId?: string; vpcId?: string }>();
    for (const reservation of (JSON.parse(described.stdout).Reservations ?? []) as Array<{
      Instances?: Array<{ InstanceId: string; SubnetId?: string; VpcId?: string }>;
    }>) {
      for (const instance of reservation.Instances ?? []) {
        placement.set(instance.InstanceId, { subnetId: instance.SubnetId, vpcId: instance.VpcId });
      }
    }

    const tablesResult = await run(["ec2", "describe-route-tables"]);
    if (tablesResult.exitCode !== 0) return { resources: {}, edges: [] };
    const tables = (JSON.parse(tablesResult.stdout).RouteTables ?? []) as RawRouteTable[];

    // Which table serves which subnet, and which is a VPC's main table — the
    // two ways an instance's subnet resolves to routing.
    const bySubnet = new Map<string, RawRouteTable>();
    const mainByVpc = new Map<string, RawRouteTable>();
    for (const table of tables) {
      for (const association of table.Associations ?? []) {
        if (association.SubnetId) bySubnet.set(association.SubnetId, table);
        if (association.Main && table.VpcId) mainByVpc.set(table.VpcId, table);
      }
    }

    for (const [logicalId, meta] of instances) {
      const where = placement.get(meta.physicalId as string);
      if (!where) continue;
      const table =
        (where.subnetId && bySubnet.get(where.subnetId)) || (where.vpcId && mainByVpc.get(where.vpcId));
      if (!table?.RouteTableId) continue;

      // Only routing that actually reaches the internet is worth reporting: an
      // internal table adds a node and an edge and answers nothing.
      const igwRoute = (table.Routes ?? []).find(
        (route) =>
          typeof route.GatewayId === "string" &&
          route.GatewayId.startsWith("igw-") &&
          (route.DestinationCidrBlock == null || route.DestinationCidrBlock === "0.0.0.0/0"),
      );
      if (!igwRoute?.GatewayId) continue;

      const subnetNode = where.subnetId ? nodeId(where.subnetId) : undefined;
      const tableNode = nodeId(table.RouteTableId);
      const gatewayNode = nodeId(igwRoute.GatewayId);
      const associationNode = `${tableNode}::assoc::${subnetNode ?? table.VpcId ?? "main"}`;
      const routeNode = `${tableNode}::route::${gatewayNode}`;

      const record = (id: string, type: string, physicalId: string | undefined, attrs: Record<string, unknown>) => {
        const existing = resources[id];
        resources[id] = {
          type,
          status: "OBSERVED",
          ...(physicalId ? { physicalId } : {}),
          attributes: attrs,
          ownership: "foreign",
          referencedBy: [...new Set([...(existing?.referencedBy ?? []), logicalId])],
        };
      };

      if (subnetNode) record(subnetNode, "AWS::EC2::Subnet", where.subnetId, { VpcId: where.vpcId });
      record(tableNode, "AWS::EC2::RouteTable", table.RouteTableId, { VpcId: table.VpcId });
      record(gatewayNode, "AWS::EC2::InternetGateway", igwRoute.GatewayId, {});
      record(associationNode, "AWS::EC2::SubnetRouteTableAssociation", undefined, {
        SubnetId: where.subnetId,
        RouteTableId: table.RouteTableId,
      });
      record(routeNode, "AWS::EC2::Route", undefined, {
        RouteTableId: table.RouteTableId,
        GatewayId: igwRoute.GatewayId,
        DestinationCidrBlock: igwRoute.DestinationCidrBlock ?? "0.0.0.0/0",
      });

      // The chain enrichEffectiveTopology walks, reported explicitly rather
      // than left to be reconstructed: an association and a route have no
      // physical id of their own, so no identity index can resolve them.
      if (subnetNode) {
        edges.push({ from: logicalId, to: subnetNode, kind: "ref", viaAttr: "SubnetId" });
        edges.push({ from: associationNode, to: subnetNode, kind: "ref", viaAttr: "SubnetId" });
      }
      edges.push({ from: associationNode, to: tableNode, kind: "ref", viaAttr: "RouteTableId" });
      edges.push({ from: routeNode, to: tableNode, kind: "ref", viaAttr: "RouteTableId" });
      edges.push({ from: routeNode, to: gatewayNode, kind: "ref", viaAttr: "GatewayId" });
    }
  } catch {
    // Best-effort: the managed observation is complete and useful on its own,
    // and failing it because an ambient dependency could not be read would
    // trade a whole answer for a partial one.
    return { resources: {}, edges: [] };
  }

  return { resources, edges };
}
