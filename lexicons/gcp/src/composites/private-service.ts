/**
 * PrivateService composite — GlobalAddress + ServiceNetworkingConnection + optional DNS.
 */

import { Composite, mergeDefaults } from "@intentius/chant";
import {
  ComputeAddress,
  ServicenetworkingConnection,
  DNSManagedZone,
} from "../generated";

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
  /** Per-member defaults for customizing individual resources. */
  defaults?: {
    globalAddress?: Partial<ConstructorParameters<typeof ComputeAddress>[0]>;
    serviceConnection?: Partial<ConstructorParameters<typeof ServicenetworkingConnection>[0]>;
    dnsZone?: Partial<ConstructorParameters<typeof DNSManagedZone>[0]>;
  };
}

export const PrivateService = Composite<PrivateServiceProps>((props) => {
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
    defaults: defs,
  } = props;

  const commonLabels: Record<string, string> = {
    "app.kubernetes.io/name": name,
    "app.kubernetes.io/managed-by": "chant",
    ...extraLabels,
  };

  const globalAddress = new ComputeAddress(mergeDefaults({
    metadata: {
      name: `${name}-address`,
      ...(namespace && { namespace }),
      labels: { ...commonLabels, "app.kubernetes.io/component": "address" },
    },
    addressType,
    purpose,
    prefixLength,
    networkRef: { name: networkName },
  } as Record<string, unknown>, defs?.globalAddress));

  const serviceConnection = new ServicenetworkingConnection(mergeDefaults({
    metadata: {
      name: `${name}-connection`,
      ...(namespace && { namespace }),
      labels: { ...commonLabels, "app.kubernetes.io/component": "connection" },
    },
    networkRef: { name: networkName },
    service: "servicenetworking.googleapis.com",
    reservedPeeringRanges: [{ name: `${name}-address` }],
  } as Record<string, unknown>, defs?.serviceConnection));

  const result: Record<string, any> = { globalAddress, serviceConnection };

  if (enableDns) {
    result.dnsZone = new DNSManagedZone(mergeDefaults({
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
    } as Record<string, unknown>, defs?.dnsZone));
  }

  return result;
}, "PrivateService");
