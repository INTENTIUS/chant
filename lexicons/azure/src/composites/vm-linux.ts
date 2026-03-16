/**
 * VmLinux composite — Linux Virtual Machine + NIC + NSG + optional Public IP.
 *
 * A higher-level construct for deploying a Linux VM with SSH access,
 * managed disk, and a Network Security Group.
 */

import { Composite, mergeDefaults } from "@intentius/chant";
import {
  VirtualMachine,
  NetworkInterface,
  NetworkSecurityGroup,
  PublicIPAddress,
} from "../generated";

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
  /** Per-member defaults. */
  defaults?: {
    virtualMachine?: Partial<ConstructorParameters<typeof VirtualMachine>[0]>;
    nic?: Partial<ConstructorParameters<typeof NetworkInterface>[0]>;
    nsg?: Partial<ConstructorParameters<typeof NetworkSecurityGroup>[0]>;
    publicIpAddress?: Partial<ConstructorParameters<typeof PublicIPAddress>[0]>;
  };
}

export interface VmLinuxResult {
  virtualMachine: InstanceType<typeof VirtualMachine>;
  nic: InstanceType<typeof NetworkInterface>;
  nsg: InstanceType<typeof NetworkSecurityGroup>;
  publicIpAddress?: InstanceType<typeof PublicIPAddress>;
}

/**
 * Create a VmLinux composite — returns a Linux VM, NIC, NSG,
 * and optional Public IP.
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
export const VmLinux = Composite<VmLinuxProps>((props) => {
  const {
    name,
    vmSize,
    adminUsername,
    sshPublicKey,
    subnetId,
    location = "[resourceGroup().location]",
    publicIp = false,
    tags = {},
    defaults,
  } = props;

  const commonTags: Record<string, string> = {
    "managed-by": "chant",
    ...tags,
  };

  const nsgName = `${name}-nsg`;
  const nicName = `${name}-nic`;
  const pipName = `${name}-pip`;

  const nsg = new NetworkSecurityGroup(mergeDefaults({
    name: nsgName,
    location,
    tags: commonTags,
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
  }, defaults?.nsg), { apiVersion: "2023-05-01" });

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

  const nic = new NetworkInterface(mergeDefaults({
    name: nicName,
    location,
    tags: commonTags,
    ipConfigurations: [ipConfiguration],
    networkSecurityGroup: {
      id: `[resourceId('Microsoft.Network/networkSecurityGroups', '${nsgName}')]`,
    },
  }, defaults?.nic), { apiVersion: "2023-05-01" });

  const virtualMachine = new VirtualMachine(mergeDefaults({
    name,
    location,
    tags: commonTags,
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
  }, defaults?.virtualMachine), { apiVersion: "2023-07-01" });

  const result: Record<string, any> = { virtualMachine, nic, nsg };

  if (publicIp) {
    result.publicIpAddress = new PublicIPAddress(mergeDefaults({
      name: pipName,
      location,
      tags: commonTags,
      sku: {
        name: "Standard",
      },
      publicIPAllocationMethod: "Static",
      publicIPAddressVersion: "IPv4",
    }, defaults?.publicIpAddress), { apiVersion: "2023-05-01" });
  }

  return result as any;
}, "VmLinux");
