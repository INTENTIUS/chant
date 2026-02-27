/**
 * VpcNetwork composite — ComputeNetwork + ComputeSubnetwork + ComputeFirewall + ComputeRouterNAT.
 */

export interface VpcSubnet {
  /** Subnet name suffix. */
  name: string;
  /** IP CIDR range. */
  ipCidrRange: string;
  /** GCP region. */
  region: string;
  /** Enable private Google access (default: true). */
  privateIpGoogleAccess?: boolean;
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
}

export interface VpcNetworkResult {
  network: Record<string, unknown>;
  subnets: Record<string, unknown>[];
  firewalls: Record<string, unknown>[];
  router?: Record<string, unknown>;
  routerNat?: Record<string, unknown>;
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
export function VpcNetwork(props: VpcNetworkProps): VpcNetworkResult {
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
  } = props;

  const commonLabels: Record<string, string> = {
    "app.kubernetes.io/name": name,
    "app.kubernetes.io/managed-by": "chant",
    ...extraLabels,
  };

  const network: Record<string, unknown> = {
    metadata: {
      name,
      ...(namespace && { namespace }),
      labels: { ...commonLabels, "app.kubernetes.io/component": "network" },
    },
    autoCreateSubnetworks,
    routingMode: "REGIONAL",
  };

  const subnets: Record<string, unknown>[] = subnetDefs.map((sub) => ({
    metadata: {
      name: `${name}-${sub.name}`,
      ...(namespace && { namespace }),
      labels: { ...commonLabels, "app.kubernetes.io/component": "subnet" },
    },
    networkRef: { name },
    ipCidrRange: sub.ipCidrRange,
    region: sub.region,
    privateIpGoogleAccess: sub.privateIpGoogleAccess ?? true,
  }));

  const firewalls: Record<string, unknown>[] = [];

  if (allowInternalTraffic) {
    firewalls.push({
      metadata: {
        name: `${name}-allow-internal`,
        ...(namespace && { namespace }),
        labels: { ...commonLabels, "app.kubernetes.io/component": "firewall" },
      },
      networkRef: { name },
      allowed: [
        { protocol: "tcp", ports: ["0-65535"] },
        { protocol: "udp", ports: ["0-65535"] },
        { protocol: "icmp" },
      ],
      sourceRanges: subnetDefs.map((s) => s.ipCidrRange),
    });
  }

  if (allowIapSsh) {
    firewalls.push({
      metadata: {
        name: `${name}-allow-iap-ssh`,
        ...(namespace && { namespace }),
        labels: { ...commonLabels, "app.kubernetes.io/component": "firewall" },
      },
      networkRef: { name },
      allowed: [{ protocol: "tcp", ports: ["22"] }],
      sourceRanges: ["35.235.240.0/20"], // IAP IP range
    });
  }

  const result: VpcNetworkResult = { network, subnets, firewalls };

  if (enableNat && natRegion) {
    const routerName = `${name}-router`;

    result.router = {
      metadata: {
        name: routerName,
        ...(namespace && { namespace }),
        labels: { ...commonLabels, "app.kubernetes.io/component": "router" },
      },
      networkRef: { name },
      region: natRegion,
    };

    result.routerNat = {
      metadata: {
        name: `${name}-nat`,
        ...(namespace && { namespace }),
        labels: { ...commonLabels, "app.kubernetes.io/component": "nat" },
      },
      routerRef: { name: routerName },
      region: natRegion,
      natIpAllocateOption: "AUTO_ONLY",
      sourceSubnetworkIpRangesToNat: "ALL_SUBNETWORKS_ALL_IP_RANGES",
    };
  }

  return result;
}
