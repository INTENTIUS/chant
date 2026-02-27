import { AksCluster, Azure } from "@intentius/chant-lexicon-azure";

export const { cluster } = AksCluster({
  name: "chant-aks",
  nodeCount: 3,
  vmSize: "Standard_D2s_v5",
  kubernetesVersion: "1.28",
  location: Azure.ResourceGroupLocation as unknown as string,
  tags: { environment: "dev" },
});
