import { AksCluster, ContainerRegistrySecure, VnetDefault, Azure } from "@intentius/chant-lexicon-azure";

export const { cluster } = AksCluster({
  name: "chant-aks",
  nodeCount: 3,
  vmSize: "Standard_D2s_v5",
  kubernetesVersion: "1.28",
  location: Azure.ResourceGroupLocation as unknown as string,
  tags: { environment: "dev" },
});

export const { registry } = ContainerRegistrySecure({
  name: "chantaksacr",
  location: Azure.ResourceGroupLocation as unknown as string,
  tags: { environment: "dev" },
});

export const { virtualNetwork, subnet1, subnet2, nsg, routeTable } = VnetDefault({
  name: "chant-aks-vnet",
  location: Azure.ResourceGroupLocation as unknown as string,
  tags: { environment: "dev" },
});
