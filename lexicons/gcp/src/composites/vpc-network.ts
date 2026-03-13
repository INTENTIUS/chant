/**
 * VpcNetwork composite — ComputeNetwork + ComputeSubnetwork + ComputeFirewall + ComputeRouterNAT.
 */

import { Composite, mergeDefaults } from "@intentius/chant";
import { VPCNetwork, Subnetwork, Firewall, Router, RouterNAT } from "../generated";

export interface VpcSubnetSecondaryRange {
  rangeName: string;
  ipCidrRange: string;
}

export interface VpcSubnet {
  /** Subnet name suffix. */
  name: string;
  /** IP CIDR range. */
  ipCidrRange: string;
  /** GCP region. */
  region: string;
  /** Enable private Google access (default: true). */
  privateIpGoogleAccess?: boolean;
  /** Secondary IP ranges for VPC-native GKE pods/services. */
  secondaryIpRanges?: VpcSubnetSecondaryRange[];
}

export interface VpcNetworkProps {
  /** Network name. */
  name: string;
  /** Auto-create subnetworks (default: false — custom mode). */
  autoCreateSubnetworks?: boolean;
  /** Subnets to create in custom mode. */
  subnets?: VpcSubnet[];
  /** Enable Cloud NAT for outbound internet access (default: false). */
  enableNat?: boolean;
  /** NAT region (required if enableNat is true). */
  natRegion?: string;
  /** Allow internal traffic firewall rule (default: true). */
  allowInternalTraffic?: boolean;
  /** Allow SSH from IAP (default: false). */
  allowIapSsh?: boolean;
  /** Additional labels. */
  labels?: Record<string, string>;
  /** Namespace for all resources. */
  namespace?: string;
  /** Per-member defaults for customizing individual resources. */
  defaults?: {
    network?: Partial<ConstructorParameters<typeof VPCNetwork>[0]>;
    router?: Partial<ConstructorParameters<typeof Router>[0]>;
    routerNat?: Partial<ConstructorParameters<typeof RouterNAT>[0]>;
  };
}

/**
 * Create a VpcNetwork composite.
 *
 * @example
 * ```ts
 * import { VpcNetwork } from "@intentius/chant-lexicon-gcp";
 *
 * const { network, subnets, firewalls } = VpcNetwork({
 *   name: "my-vpc",
 *   subnets: [
 *     { name: "app", ipCidrRange: "10.0.0.0/24", region: "us-central1" },
 *     { name: "data", ipCidrRange: "10.0.1.0/24", region: "us-central1" },
 *   ],
 *   enableNat: true,
 *   natRegion: "us-central1",
 * });
 * ```
 */
export const VpcNetwork = Composite<VpcNetworkProps>((props) => {
  const {
    name,
    autoCreateSubnetworks = false,
    subnets: subnetDefs = [],
    enableNat = false,
    natRegion,
    allowInternalTraffic = true,
    allowIapSsh = false,
    labels: extraLabels = {},
    namespace,
    defaults: defs,
  } = props;

  const commonLabels: Record<string, string> = {
    "app.kubernetes.io/name": name,
    "app.kubernetes.io/managed-by": "chant",
    ...extraLabels,
  };

  const network = new VPCNetwork(mergeDefaults({
    metadata: {
      name,
      ...(namespace && { namespace }),
      labels: { ...commonLabels, "app.kubernetes.io/component": "network" },
    },
    autoCreateSubnetworks,
    routingMode: "REGIONAL",
  } as Record<string, unknown>, defs?.network));

  // Spread subnets into named members (subnet_<name>) for Composite validation.
  const subnetEntries: Record<string, any> = {};
  for (const sub of subnetDefs) {
    subnetEntries[`subnet_${sub.name}`] = new Subnetwork({
      metadata: {
        name: `${name}-${sub.name}`,
        ...(namespace && { namespace }),
        labels: { ...commonLabels, "app.kubernetes.io/component": "subnet" },
      },
      networkRef: { name },
      ipCidrRange: sub.ipCidrRange,
      region: sub.region,
      privateIpGoogleAccess: sub.privateIpGoogleAccess ?? true,
      ...(sub.secondaryIpRanges && sub.secondaryIpRanges.length > 0 && {
        secondaryIpRange: sub.secondaryIpRanges,
      }),
    } as Record<string, unknown>);
  }

  // Spread firewalls into named members for Composite validation.
  const firewallEntries: Record<string, any> = {};

  if (allowInternalTraffic) {
    firewallEntries.firewallAllowInternal = new Firewall({
      metadata: {
        name: `${name}-allow-internal`,
        ...(namespace && { namespace }),
        labels: { ...commonLabels, "app.kubernetes.io/component": "firewall" },
      },
      networkRef: { name },
      allow: [
        { protocol: "tcp", ports: ["0-65535"] },
        { protocol: "udp", ports: ["0-65535"] },
        { protocol: "icmp" },
      ],
      sourceRanges: subnetDefs.map((s) => s.ipCidrRange),
    } as Record<string, unknown>);
  }

  if (allowIapSsh) {
    firewallEntries.firewallAllowIapSsh = new Firewall({
      metadata: {
        name: `${name}-allow-iap-ssh`,
        ...(namespace && { namespace }),
        labels: { ...commonLabels, "app.kubernetes.io/component": "firewall" },
      },
      networkRef: { name },
      allow: [{ protocol: "tcp", ports: ["22"] }],
      sourceRanges: ["35.235.240.0/20"], // IAP IP range
    } as Record<string, unknown>);
  }

  const result: Record<string, any> = { network, ...subnetEntries, ...firewallEntries };

  if (enableNat && natRegion) {
    const routerName = `${name}-router`;

    result.router = new Router(mergeDefaults({
      metadata: {
        name: routerName,
        ...(namespace && { namespace }),
        labels: { ...commonLabels, "app.kubernetes.io/component": "router" },
      },
      networkRef: { name },
      region: natRegion,
    } as Record<string, unknown>, defs?.router));

    result.routerNat = new RouterNAT(mergeDefaults({
      metadata: {
        name: `${name}-nat`,
        ...(namespace && { namespace }),
        labels: { ...commonLabels, "app.kubernetes.io/component": "nat" },
      },
      routerRef: { name: routerName },
      region: natRegion,
      natIpAllocateOption: "AUTO_ONLY",
      sourceSubnetworkIpRangesToNat: "ALL_SUBNETWORKS_ALL_IP_RANGES",
    } as Record<string, unknown>, defs?.routerNat));
  }

  return result;
}, "VpcNetwork");
