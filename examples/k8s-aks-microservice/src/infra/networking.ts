// Azure infrastructure: VNet with subnets for AKS.
//
// Uses the VnetDefault composite which creates:
// - Virtual Network with address space
// - 2 subnets with NSG and Route Table
// - Network Security Group
// - Route Table

import { VnetDefault, Azure } from "@intentius/chant-lexicon-azure";

export const { virtualNetwork, subnet1, subnet2, nsg, routeTable } = VnetDefault({
  name: "aks-microservice-vnet",
  location: Azure.ResourceGroupLocation as unknown as string,
  tags: { environment: "production" },
});
