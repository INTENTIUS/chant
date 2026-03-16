/**
 * AksCluster composite — Azure Kubernetes Service cluster.
 *
 * A higher-level construct for deploying an AKS cluster with
 * managed identity, RBAC, and a default node pool.
 */

import { Composite, mergeDefaults } from "@intentius/chant";
import { AksCluster as AksClusterResource } from "../generated";

export interface AksClusterProps {
  /** Cluster name. */
  name: string;
  /** Number of nodes in the default pool (default: 3). */
  nodeCount?: number;
  /** VM size for the default node pool (default: "Standard_D2s_v5"). */
  vmSize?: string;
  /** Kubernetes version (default: "1.28"). */
  kubernetesVersion?: string;
  /** Azure region (default: resource group location). */
  location?: string;
  /** Resource tags. */
  tags?: Record<string, string>;
  /** Per-member defaults. */
  defaults?: {
    cluster?: Partial<ConstructorParameters<typeof AksClusterResource>[0]>;
  };
}

export interface AksClusterResult {
  cluster: InstanceType<typeof AksClusterResource>;
}

/**
 * Create an AksCluster composite — returns an AKS managed cluster
 * with production defaults.
 *
 * @example
 * ```ts
 * import { AksCluster } from "@intentius/chant-lexicon-azure";
 *
 * const { cluster } = AksCluster({
 *   name: "my-aks",
 *   nodeCount: 5,
 *   vmSize: "Standard_D4s_v5",
 *   kubernetesVersion: "1.29",
 * });
 *
 * export { cluster };
 * ```
 */
export const AksCluster = Composite<AksClusterProps>((props) => {
  const {
    name,
    nodeCount = 3,
    vmSize = "Standard_D2s_v5",
    kubernetesVersion = "1.28",
    location = "[resourceGroup().location]",
    tags = {},
    defaults,
  } = props;

  const commonTags: Record<string, string> = {
    "managed-by": "chant",
    ...tags,
  };

  const dnsPrefix = name;

  const cluster = new AksClusterResource(mergeDefaults({
    name,
    location,
    tags: commonTags,
    identity: {
      type: "SystemAssigned",
    },
    kubernetesVersion,
    dnsPrefix,
    enableRBAC: true,
    agentPoolProfiles: [
      {
        name: "default",
        count: nodeCount,
        vmSize,
        osType: "Linux",
        mode: "System",
        enableAutoScaling: false,
        type: "VirtualMachineScaleSets",
      },
    ],
    networkProfile: {
      networkPlugin: "azure",
      loadBalancerSku: "standard",
      serviceCidr: "10.0.0.0/16",
      dnsServiceIP: "10.0.0.10",
    },
    addonProfiles: {
      omsagent: {
        enabled: false,
      },
    },
  }, defaults?.cluster), { apiVersion: "2023-08-01" });

  return { cluster };
}, "AksCluster");
