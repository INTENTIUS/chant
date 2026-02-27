/**
 * AksCluster composite — Azure Kubernetes Service cluster.
 *
 * A higher-level construct for deploying an AKS cluster with
 * managed identity, RBAC, and a default node pool.
 */

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
}

export interface AksClusterResult {
  cluster: Record<string, unknown>;
}

/**
 * Create an AksCluster composite — returns a property object for
 * an AKS managed cluster with production defaults.
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
export function AksCluster(props: AksClusterProps): AksClusterResult {
  const {
    name,
    nodeCount = 3,
    vmSize = "Standard_D2s_v5",
    kubernetesVersion = "1.28",
    location = "[resourceGroup().location]",
    tags = {},
  } = props;

  const commonTags: Record<string, string> = {
    "managed-by": "chant",
    ...tags,
  };

  const dnsPrefix = name;

  const cluster: Record<string, unknown> = {
    type: "Microsoft.ContainerService/managedClusters",
    apiVersion: "2023-08-01",
    name,
    location,
    tags: commonTags,
    identity: {
      type: "SystemAssigned",
    },
    properties: {
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
    },
  };

  return { cluster };
}
