// Azure infrastructure: VNet (10.2.0.0/16) with subnets for AKS.
// NSG rules allow CockroachDB ports from AWS and GCP VPN peers.

import {
  VnetDefault,
  Subnet,
  Azure,
  NetworkSecurityGroup,
} from "@intentius/chant-lexicon-azure";

export const { virtualNetwork, subnet1, subnet2, nsg, routeTable } = VnetDefault({
  name: "aks-cockroachdb-vnet",
  addressSpace: "10.2.0.0/16",
  location: Azure.ResourceGroupLocation as unknown as string,
  tags: { environment: "production", "managed-by": "chant" },
});

// Azure VPN Gateways require a subnet named exactly "GatewaySubnet".
export const gatewaySubnet = new Subnet({
  type: "Microsoft.Network/virtualNetworks/subnets",
  apiVersion: "2023-05-01",
  name: "aks-cockroachdb-vnet/GatewaySubnet",
  properties: {
    addressPrefix: "10.2.255.0/27",
  },
});
