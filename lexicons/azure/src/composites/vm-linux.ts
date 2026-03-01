/**
 * VmLinux composite — Linux Virtual Machine + NIC + NSG + optional Public IP.
 *
 * A higher-level construct for deploying a Linux VM with SSH access,
 * managed disk, and a Network Security Group.
 */

import { markAsAzureResource } from "./from-arm";

export interface VmLinuxProps {
  /** Virtual machine name. */
  name: string;
  /** VM size (e.g., "Standard_B2s", "Standard_D2s_v5"). */
  vmSize: string;
  /** Admin username for SSH. */
  adminUsername: string;
  /** SSH public key for authentication. */
  sshPublicKey: string;
  /** Subnet resource ID where the NIC will be placed. */
  subnetId: string;
  /** Azure region (default: resource group location). */
  location?: string;
  /** Create a public IP address (default: false). */
  publicIp?: boolean;
  /** Resource tags. */
  tags?: Record<string, string>;
}

export interface VmLinuxResult {
  virtualMachine: Record<string, unknown>;
  nic: Record<string, unknown>;
  nsg: Record<string, unknown>;
  publicIpAddress?: Record<string, unknown>;
}

/**
 * Create a VmLinux composite — returns property objects for
 * a Linux VM, NIC, NSG, and optional Public IP.
 *
 * @example
 * ```ts
 * import { VmLinux } from "@intentius/chant-lexicon-azure";
 *
 * const { virtualMachine, nic, nsg, publicIpAddress } = VmLinux({
 *   name: "my-vm",
 *   vmSize: "Standard_B2s",
 *   adminUsername: "azureuser",
 *   sshPublicKey: "ssh-rsa AAAA...",
 *   subnetId: "[resourceId('Microsoft.Network/virtualNetworks/subnets', 'my-vnet', 'subnet-1')]",
 *   publicIp: true,
 * });
 *
 * export { virtualMachine, nic, nsg, publicIpAddress };
 * ```
 */
export function VmLinux(props: VmLinuxProps): VmLinuxResult {
  const {
    name,
    vmSize,
    adminUsername,
    sshPublicKey,
    subnetId,
    location = "[resourceGroup().location]",
    publicIp = false,
    tags = {},
  } = props;

  const commonTags: Record<string, string> = {
    "managed-by": "chant",
    ...tags,
  };

  const nsgName = `${name}-nsg`;
  const nicName = `${name}-nic`;
  const pipName = `${name}-pip`;

  const nsg: Record<string, unknown> = {
    type: "Microsoft.Network/networkSecurityGroups",
    apiVersion: "2023-05-01",
    name: nsgName,
    location,
    tags: commonTags,
    properties: {
      securityRules: [
        {
          name: "AllowSSH",
          properties: {
            priority: 1000,
            direction: "Inbound",
            access: "Allow",
            protocol: "Tcp",
            sourcePortRange: "*",
            destinationPortRange: "22",
            sourceAddressPrefix: "*",
            destinationAddressPrefix: "*",
          },
        },
      ],
    },
  };

  const ipConfiguration: Record<string, unknown> = {
    name: "ipconfig1",
    properties: {
      privateIPAllocationMethod: "Dynamic",
      subnet: {
        id: subnetId,
      },
      ...(publicIp && {
        publicIPAddress: {
          id: `[resourceId('Microsoft.Network/publicIPAddresses', '${pipName}')]`,
        },
      }),
    },
  };

  const nic: Record<string, unknown> = {
    type: "Microsoft.Network/networkInterfaces",
    apiVersion: "2023-05-01",
    name: nicName,
    location,
    tags: commonTags,
    properties: {
      ipConfigurations: [ipConfiguration],
      networkSecurityGroup: {
        id: `[resourceId('Microsoft.Network/networkSecurityGroups', '${nsgName}')]`,
      },
    },
  };

  const virtualMachine: Record<string, unknown> = {
    type: "Microsoft.Compute/virtualMachines",
    apiVersion: "2023-07-01",
    name,
    location,
    tags: commonTags,
    properties: {
      hardwareProfile: {
        vmSize,
      },
      osProfile: {
        computerName: name,
        adminUsername,
        linuxConfiguration: {
          disablePasswordAuthentication: true,
          ssh: {
            publicKeys: [
              {
                path: `/home/${adminUsername}/.ssh/authorized_keys`,
                keyData: sshPublicKey,
              },
            ],
          },
        },
      },
      storageProfile: {
        imageReference: {
          publisher: "Canonical",
          offer: "0001-com-ubuntu-server-jammy",
          sku: "22_04-lts-gen2",
          version: "latest",
        },
        osDisk: {
          createOption: "FromImage",
          managedDisk: {
            storageAccountType: "Premium_LRS",
          },
        },
      },
      networkProfile: {
        networkInterfaces: [
          {
            id: `[resourceId('Microsoft.Network/networkInterfaces', '${nicName}')]`,
          },
        ],
      },
    },
  };

  markAsAzureResource(nsg);
  markAsAzureResource(nic);
  markAsAzureResource(virtualMachine);

  const result: VmLinuxResult = { virtualMachine, nic, nsg };

  if (publicIp) {
    result.publicIpAddress = {
      type: "Microsoft.Network/publicIPAddresses",
      apiVersion: "2023-05-01",
      name: pipName,
      location,
      tags: commonTags,
      sku: {
        name: "Standard",
      },
      properties: {
        publicIPAllocationMethod: "Static",
        publicIPAddressVersion: "IPv4",
      },
    };
    markAsAzureResource(result.publicIpAddress);
  }

  return result;
}
