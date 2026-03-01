import {
  StorageAccountSecure,
  PrivateEndpoint,
  VnetDefault,
  ResourceId,
  Azure,
} from "@intentius/chant-lexicon-azure";

const { virtualNetwork, subnet1, subnet2, nsg, routeTable } = VnetDefault({
  name: "pe-vnet",
  location: Azure.ResourceGroupLocation as unknown as string,
});

const { storageAccount } = StorageAccountSecure({
  name: "chantstpe",
  location: Azure.ResourceGroupLocation as unknown as string,
  tags: { environment: "dev" },
});

const { privateEndpoint, privateDnsZone, dnsZoneGroup, vnetLink } = PrivateEndpoint({
  name: "storage-pe",
  targetResourceId: ResourceId("Microsoft.Storage/storageAccounts", "chantstpe") as unknown as string,
  groupId: "blob",
  subnetId: ResourceId("Microsoft.Network/virtualNetworks/subnets", "pe-vnet", "subnet-1") as unknown as string,
  privateDnsZoneName: "privatelink.blob.core.windows.net",
  vnetId: ResourceId("Microsoft.Network/virtualNetworks", "pe-vnet") as unknown as string,
  location: Azure.ResourceGroupLocation as unknown as string,
  tags: { environment: "dev" },
});

export {
  virtualNetwork, subnet1, subnet2, nsg, routeTable,
  storageAccount,
  privateEndpoint, privateDnsZone, dnsZoneGroup, vnetLink,
};
