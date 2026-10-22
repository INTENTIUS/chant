/**
 * PrivateEgressNetwork composite: a custom-mode VPC with one subnet a service sends its egress into.
 */

import { Composite, mergeDefaults } from "@intentius/chant";
import { VPCNetwork, Subnetwork } from "../generated";

export interface PrivateEgressNetworkProps {
  /** Name prefix: the network is `<name>-vpc`, its subnet `<name>-apps`. */
  name: string;
  /** GCP region of the subnet. */
  region: string;
  /** IP CIDR range of the subnet. */
  subnetCidr: string;
  /** Enable private Google access on the subnet (default: true). */
  privateIpGoogleAccess?: boolean;
  /** Additional labels. */
  labels?: Record<string, string>;
  /** Namespace for all resources. */
  namespace?: string;
  /** Per-member defaults for customizing individual resources. */
  defaults?: {
    vpc?: Partial<ConstructorParameters<typeof VPCNetwork>[0]>;
    subnet?: Partial<ConstructorParameters<typeof Subnetwork>[0]>;
  };
}

/**
 * Create a PrivateEgressNetwork composite.
 *
 * @example
 * ```ts
 * import { PrivateEgressNetwork } from "@intentius/chant-lexicon-gcp";
 *
 * const { vpc, subnet } = PrivateEgressNetwork({
 *   name: "web",
 *   region: "us-central1",
 *   subnetCidr: "10.10.0.0/24",
 * });
 * ```
 */
export const PrivateEgressNetwork = Composite((props: PrivateEgressNetworkProps) => {
  const {
    name,
    region,
    subnetCidr,
    privateIpGoogleAccess = true,
    labels: extraLabels = {},
    namespace,
    defaults: defs,
  } = props;

  const commonLabels: Record<string, string> = {
    "app.kubernetes.io/name": name,
    "app.kubernetes.io/managed-by": "chant",
    ...extraLabels,
  };

  const vpc = new VPCNetwork(mergeDefaults({
    metadata: {
      name: `${name}-vpc`,
      ...(namespace && { namespace }),
      labels: { ...commonLabels, "app.kubernetes.io/component": "network" },
    },
    autoCreateSubnetworks: false,
    routingMode: "REGIONAL",
  } as Record<string, unknown>, defs?.vpc));

  const subnet = new Subnetwork(mergeDefaults({
    metadata: {
      name: `${name}-apps`,
      ...(namespace && { namespace }),
      labels: { ...commonLabels, "app.kubernetes.io/component": "subnet" },
    },
    region,
    ipCidrRange: subnetCidr,
    privateIpGoogleAccess,
    networkRef: { name: vpc.name },
  } as Record<string, unknown>, defs?.subnet));

  return { vpc, subnet };
}, "PrivateEgressNetwork");
