/**
 * PrivateService composite — GlobalAddress + ServiceNetworkingConnection + optional DNS.
 */

export interface PrivateServiceProps {
  /** Service name. */
  name: string;
  /** VPC network name to peer with. */
  networkName: string;
  /** IP address prefix length (default: 16). */
  prefixLength?: number;
  /** Address type (default: "INTERNAL"). */
  addressType?: string;
  /** Purpose (default: "VPC_PEERING"). */
  purpose?: string;
  /** Enable a DNS zone for the private service (default: false). */
  enableDns?: boolean;
  /** DNS zone name (default: "{name}-dns"). */
  dnsZoneName?: string;
  /** DNS name suffix (default: "internal."). */
  dnsSuffix?: string;
  /** Additional labels. */
  labels?: Record<string, string>;
  /** Namespace for all resources. */
  namespace?: string;
}

export interface PrivateServiceResult {
  globalAddress: Record<string, unknown>;
  serviceConnection: Record<string, unknown>;
  dnsZone?: Record<string, unknown>;
}

export function PrivateService(props: PrivateServiceProps): PrivateServiceResult {
  const {
    name,
    networkName,
    prefixLength = 16,
    addressType = "INTERNAL",
    purpose = "VPC_PEERING",
    enableDns = false,
    dnsZoneName,
    dnsSuffix = "internal.",
    labels: extraLabels = {},
    namespace,
  } = props;

  const commonLabels: Record<string, string> = {
    "app.kubernetes.io/name": name,
    "app.kubernetes.io/managed-by": "chant",
    ...extraLabels,
  };

  const globalAddress: Record<string, unknown> = {
    metadata: {
      name: `${name}-address`,
      ...(namespace && { namespace }),
      labels: { ...commonLabels, "app.kubernetes.io/component": "address" },
    },
    addressType,
    purpose,
    prefixLength,
    networkRef: { name: networkName },
  };

  const serviceConnection: Record<string, unknown> = {
    metadata: {
      name: `${name}-connection`,
      ...(namespace && { namespace }),
      labels: { ...commonLabels, "app.kubernetes.io/component": "connection" },
    },
    networkRef: { name: networkName },
    service: "servicenetworking.googleapis.com",
    reservedPeeringRanges: [{ name: `${name}-address` }],
  };

  const result: PrivateServiceResult = { globalAddress, serviceConnection };

  if (enableDns) {
    result.dnsZone = {
      metadata: {
        name: dnsZoneName ?? `${name}-dns`,
        ...(namespace && { namespace }),
        labels: { ...commonLabels, "app.kubernetes.io/component": "dns" },
      },
      dnsName: dnsSuffix,
      visibility: "private",
      privateVisibilityConfig: {
        networks: [{ networkRef: { name: networkName } }],
      },
    };
  }

  return result;
}
