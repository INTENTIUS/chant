import { VnetDefault, VmLinux, ResourceId, Azure } from "@intentius/chant-lexicon-azure";

const location = Azure.ResourceGroupLocation as unknown as string;

// --- Network layer ---

export const { virtualNetwork, subnet1, subnet2, nsg: vnetNsg, routeTable } = VnetDefault({
  name: "example-vnet",
  addressPrefix: "10.0.0.0/16",
  subnetPrefixes: ["10.0.1.0/24", "10.0.2.0/24"],
  location,
  tags: { layer: "network" },
});

// --- Compute layer ---

const subnetRef = ResourceId(
  "Microsoft.Network/virtualNetworks/subnets",
  "example-vnet",
  "subnet-1",
) as unknown as string;

export const { virtualMachine, nic, nsg: vmNsg } = VmLinux({
  name: "example-vm",
  vmSize: "Standard_B2s",
  adminUsername: "azureuser",
  sshPublicKey: "ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABAQC7... user@example",
  subnetId: subnetRef,
  location,
  tags: { layer: "compute" },
});
