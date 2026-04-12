/**
 * MultiRegionVpc composite — VPC + 2 subnets per region + Router + RouterNAT per region + Firewall.
 *
 * Collapses the boilerplate of a multi-region GKE networking stack into a single call.
 * Each region gets node and pod subnets, a Cloud Router, and a Cloud NAT gateway.
 * A single allow-internal firewall rule covers all region CIDRs.
 */

import { Composite } from "@intentius/chant";
import { VPCNetwork, Subnetwork, Router, RouterNAT, Firewall } from "../generated";

export interface MultiRegionVpcRegion {
  /** GCP region name (e.g. "us-east4"). Used as the Router/NAT region. */
  region: string;
  /**
   * Short alias used in resource names (e.g. "east").
   * Defaults to the full region string. Use this to keep names concise.
   */
  regionAlias?: string;
  /** IP CIDR for GKE node subnet (e.g. "10.1.0.0/20"). */
  nodeSubnetCidr: string;
  /** IP CIDR for GKE pod subnet (e.g. "10.1.16.0/20"). */
  podSubnetCidr: string;
}

export interface MultiRegionVpcConfig {
  /** VPC network name. Used as prefix for all sub-resources. */
  name: string;
  /** One entry per GCP region. */
  regions: MultiRegionVpcRegion[];
  /** Enable VPC flow logs on all subnets (default: false). */
  enableFlowLogs?: boolean;
  /** Additional labels for all resources. */
  labels?: Record<string, string>;
  /** Namespace for Config Connector resources. */
  namespace?: string;
}

/**
 * Create a MultiRegionVpc composite — one VPC with subnets, Cloud NAT, and an
 * allow-internal firewall for every region in the array.
 *
 * The composite eliminates the per-region Router/NAT boilerplate that arises when
 * `VpcNetwork` only handles a single NAT region and the rest must be wired manually.
 *
 * @example
 * ```ts
 * import { MultiRegionVpc } from "@intentius/chant-lexicon-gcp";
 *
 * export const network = MultiRegionVpc({
 *   name: "crdb-multi-region",
 *   regions: [
 *     { region: "us-east4",    regionAlias: "east",    nodeSubnetCidr: "10.1.0.0/20", podSubnetCidr: "10.1.16.0/20" },
 *     { region: "us-central1", regionAlias: "central", nodeSubnetCidr: "10.2.0.0/20", podSubnetCidr: "10.2.16.0/20" },
 *     { region: "us-west1",    regionAlias: "west",    nodeSubnetCidr: "10.3.0.0/20", podSubnetCidr: "10.3.16.0/20" },
 *   ],
 * });
 * ```
 */
export const MultiRegionVpc = Composite<MultiRegionVpcConfig>((props) => {
  const {
    name,
    regions,
    enableFlowLogs = false,
    labels: extraLabels = {},
    namespace,
  } = props;

  const commonLabels: Record<string, string> = {
    "app.kubernetes.io/name": name,
    "app.kubernetes.io/managed-by": "chant",
    ...extraLabels,
  };

  const meta = (component: string, resourceName?: string) => ({
    metadata: {
      name: resourceName ?? name,
      ...(namespace && { namespace }),
      labels: { ...commonLabels, "app.kubernetes.io/component": component },
    },
  });

  const network = new VPCNetwork({
    ...meta("network"),
    autoCreateSubnetworks: false,
    routingMode: "REGIONAL",
  } as Record<string, unknown>);

  const subnetEntries: Record<string, unknown> = {};
  const routerEntries: Record<string, unknown> = {};
  const natEntries: Record<string, unknown> = {};
  const allCidrs: string[] = [];

  for (const r of regions) {
    const alias = r.regionAlias ?? r.region;

    allCidrs.push(r.nodeSubnetCidr, r.podSubnetCidr);

    const flowConfig = enableFlowLogs
      ? { logConfig: { enable: true, aggregationInterval: "INTERVAL_5_SEC", flowSampling: 0.5 } }
      : {};

    subnetEntries[`subnet_${alias}_nodes`] = new Subnetwork({
      ...meta("subnet", `${name}-${alias}-nodes`),
      networkRef: { name },
      ipCidrRange: r.nodeSubnetCidr,
      region: r.region,
      privateIpGoogleAccess: true,
      ...flowConfig,
    } as Record<string, unknown>);

    subnetEntries[`subnet_${alias}_pods`] = new Subnetwork({
      ...meta("subnet", `${name}-${alias}-pods`),
      networkRef: { name },
      ipCidrRange: r.podSubnetCidr,
      region: r.region,
      privateIpGoogleAccess: true,
      ...flowConfig,
    } as Record<string, unknown>);

    const routerName = `${name}-${alias}`;

    routerEntries[`router_${alias}`] = new Router({
      ...meta("router", routerName),
      networkRef: { name },
      region: r.region,
    } as Record<string, unknown>);

    natEntries[`nat_${alias}`] = new RouterNAT({
      ...meta("nat", routerName),
      routerRef: { name: routerName },
      region: r.region,
      natIpAllocateOption: "AUTO_ONLY",
      sourceSubnetworkIpRangesToNat: "ALL_SUBNETWORKS_ALL_PRIMARY_IP_RANGES",
    } as Record<string, unknown>);
  }

  // Allow all TCP/UDP/ICMP between every subnet CIDR in the VPC.
  const firewallInternal = new Firewall({
    ...meta("firewall", `${name}-allow-internal`),
    networkRef: { name },
    allow: [
      { protocol: "tcp", ports: ["0-65535"] },
      { protocol: "udp", ports: ["0-65535"] },
      { protocol: "icmp" },
    ],
    sourceRanges: allCidrs,
  } as Record<string, unknown>);

  return {
    network,
    ...subnetEntries,
    ...routerEntries,
    ...natEntries,
    firewallInternal,
  };
}, "MultiRegionVpc");
