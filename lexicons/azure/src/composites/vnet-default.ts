/**
 * VnetDefault composite — Virtual Network + Subnets + NSG + Route Table.
 *
 * A higher-level construct for a standard Azure virtual network with
 * two subnets, a Network Security Group, and a Route Table.
 */

import { markAsAzureResource } from "./from-arm";

export interface VnetDefaultProps {
  /** Virtual network name. */
  name: string;
  /** Address space prefix (default: "10.0.0.0/16"). */
  addressPrefix?: string;
  /** Subnet address prefixes [subnet1, subnet2] (default: ["10.0.1.0/24", "10.0.2.0/24"]). */
  subnetPrefixes?: [string, string];
  /** Azure region (default: resource group location). */
  location?: string;
  /** Resource tags. */
  tags?: Record<string, string>;
}

export interface VnetDefaultResult {
  virtualNetwork: Record<string, unknown>;
  subnet1: Record<string, unknown>;
  subnet2: Record<string, unknown>;
  nsg: Record<string, unknown>;
  routeTable: Record<string, unknown>;
}

/**
 * Create a VnetDefault composite — returns property objects for
 * a Virtual Network, two Subnets, an NSG, and a Route Table.
 *
 * @example
 * ```ts
 * import { VnetDefault } from "@intentius/chant-lexicon-azure";
 *
 * const { virtualNetwork, subnet1, subnet2, nsg, routeTable } = VnetDefault({
 *   name: "my-vnet",
 *   addressPrefix: "10.0.0.0/16",
 *   subnetPrefixes: ["10.0.1.0/24", "10.0.2.0/24"],
 * });
 *
 * export { virtualNetwork, subnet1, subnet2, nsg, routeTable };
 * ```
 */
export function VnetDefault(props: VnetDefaultProps): VnetDefaultResult {
  const {
    name,
    addressPrefix = "10.0.0.0/16",
    subnetPrefixes = ["10.0.1.0/24", "10.0.2.0/24"],
    location = "[resourceGroup().location]",
    tags = {},
  } = props;

  const commonTags: Record<string, string> = {
    "managed-by": "chant",
    ...tags,
  };

  const nsgName = `${name}-nsg`;
  const routeTableName = `${name}-rt`;

  const nsg: Record<string, unknown> = {
    type: "Microsoft.Network/networkSecurityGroups",
    apiVersion: "2023-05-01",
    name: nsgName,
    location,
    tags: commonTags,
    properties: {
      securityRules: [],
    },
  };

  const routeTable: Record<string, unknown> = {
    type: "Microsoft.Network/routeTables",
    apiVersion: "2023-05-01",
    name: routeTableName,
    location,
    tags: commonTags,
    properties: {
      disableBgpRoutePropagation: false,
      routes: [],
    },
  };

  const subnet1: Record<string, unknown> = {
    type: "Microsoft.Network/virtualNetworks/subnets",
    apiVersion: "2023-05-01",
    name: `${name}/subnet-1`,
    properties: {
      addressPrefix: subnetPrefixes[0],
      networkSecurityGroup: {
        id: `[resourceId('Microsoft.Network/networkSecurityGroups', '${nsgName}')]`,
      },
      routeTable: {
        id: `[resourceId('Microsoft.Network/routeTables', '${routeTableName}')]`,
      },
    },
  };

  const subnet2: Record<string, unknown> = {
    type: "Microsoft.Network/virtualNetworks/subnets",
    apiVersion: "2023-05-01",
    name: `${name}/subnet-2`,
    properties: {
      addressPrefix: subnetPrefixes[1],
      networkSecurityGroup: {
        id: `[resourceId('Microsoft.Network/networkSecurityGroups', '${nsgName}')]`,
      },
      routeTable: {
        id: `[resourceId('Microsoft.Network/routeTables', '${routeTableName}')]`,
      },
    },
  };

  const virtualNetwork: Record<string, unknown> = {
    type: "Microsoft.Network/virtualNetworks",
    apiVersion: "2023-05-01",
    name,
    location,
    tags: commonTags,
    properties: {
      addressSpace: {
        addressPrefixes: [addressPrefix],
      },
      subnets: [
        {
          name: "subnet-1",
          properties: {
            addressPrefix: subnetPrefixes[0],
            networkSecurityGroup: {
              id: `[resourceId('Microsoft.Network/networkSecurityGroups', '${nsgName}')]`,
            },
            routeTable: {
              id: `[resourceId('Microsoft.Network/routeTables', '${routeTableName}')]`,
            },
          },
        },
        {
          name: "subnet-2",
          properties: {
            addressPrefix: subnetPrefixes[1],
            networkSecurityGroup: {
              id: `[resourceId('Microsoft.Network/networkSecurityGroups', '${nsgName}')]`,
            },
            routeTable: {
              id: `[resourceId('Microsoft.Network/routeTables', '${routeTableName}')]`,
            },
          },
        },
      ],
    },
  };

  markAsAzureResource(nsg);
  markAsAzureResource(routeTable);
  markAsAzureResource(subnet1);
  markAsAzureResource(subnet2);
  markAsAzureResource(virtualNetwork);

  return { virtualNetwork, subnet1, subnet2, nsg, routeTable };
}
