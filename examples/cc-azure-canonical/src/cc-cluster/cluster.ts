/**
 * The CC lane's canonical example, cluster half (chant#1200 / #1214).
 *
 * A raw generated `AksCluster` rather than the AksCluster composite: floci-az
 * 0.10.0's modeled managedClusters provider echoes only what it models —
 * `identity`, `networkProfile`, `addonProfiles` and the pool fields beyond
 * name/count/vmSize/osType/mode are dropped on PUT (test/floci-gaps.md
 * entry 9, the same class as the storage-account entry 7) — so the composite's
 * production defaults would put honest-but-emulator-made `absent` drift on
 * every clean apply. This declares exactly the surface that round-trips.
 *
 * floci-az backs the cluster with a real k3s container; the harness reaches it
 * through the cluster's own admin kubeconfig (see test/azure-cc-e2e.sh) and
 * the k8s half (`../cc-workload/`) lands on it.
 */
import { AksCluster } from "@intentius/chant-lexicon-azure/generated/index";

export const cluster = new AksCluster({
  name: "cc-aks",
  tags: { environment: "cc-e2e", "managed-by": "chant" },
  kubernetesVersion: "1.31.0",
  dnsPrefix: "cc-aks",
  enableRBAC: true,
  agentPoolProfiles: [
    { name: "default", count: 1, vmSize: "Standard_B2s", osType: "Linux", mode: "System" },
  ],
});
