/**
 * VnetDefault composite — Virtual Network + Subnets + NSG + Route Table.
 *
 * A higher-level construct for a standard Azure virtual network with
 * two subnets, a Network Security Group, and a Route Table.
 */

import { Composite, mergeDefaults } from "@intentius/chant";
import {
  VirtualNetwork,
  Subnet,
  NetworkSecurityGroup,
  RouteTable,
} from "../generated";

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
  /** Per-member defaults. */
  defaults?: {
    virtualNetwork?: Partial<ConstructorParameters<typeof VirtualNetwork>[0]>;
    subnet1?: Partial<ConstructorParameters<typeof Subnet>[0]>;
    subnet2?: Partial<ConstructorParameters<typeof Subnet>[0]>;
    nsg?: Partial<ConstructorParameters<typeof NetworkSecurityGroup>[0]>;
    routeTable?: Partial<ConstructorParameters<typeof RouteTable>[0]>;
  };
}

export interface VnetDefaultResult {
  virtualNetwork: InstanceType<typeof VirtualNetwork>;
  subnet1: InstanceType<typeof Subnet>;
  subnet2: InstanceType<typeof Subnet>;
  nsg: InstanceType<typeof NetworkSecurityGroup>;
  routeTable: InstanceType<typeof RouteTable>;
}

/**
 * Create a VnetDefault composite — returns a Virtual Network,
 * two Subnets, an NSG, and a Route Table.
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
export const VnetDefault = Composite<VnetDefaultProps>((props) => {
  const {
    name,
    addressPrefix = "10.0.0.0/16",
    subnetPrefixes = ["10.0.1.0/24", "10.0.2.0/24"],
    location = "[resourceGroup().location]",
    tags = {},
    defaults,
  } = props;

  const commonTags: Record<string, string> = {
    "managed-by": "chant",
    ...tags,
  };

  const nsgName = `${name}-nsg`;
  const routeTableName = `${name}-rt`;

  const nsg = new NetworkSecurityGroup(mergeDefaults({
    name: nsgName,
    location,
    tags: commonTags,
    securityRules: [],
  }, defaults?.nsg), { apiVersion: "2023-05-01" });

  const routeTable = new RouteTable(mergeDefaults({
    name: routeTableName,
    location,
    tags: commonTags,
    disableBgpRoutePropagation: false,
    routes: [],
  }, defaults?.routeTable), { apiVersion: "2023-05-01" });

  const subnet1 = new Subnet(mergeDefaults({
    name: `${name}/subnet-1`,
    addressPrefix: subnetPrefixes[0],
    networkSecurityGroup: {
      id: `[resourceId('Microsoft.Network/networkSecurityGroups', '${nsgName}')]`,
    },
    routeTable: {
      id: `[resourceId('Microsoft.Network/routeTables', '${routeTableName}')]`,
    },
  }, defaults?.subnet1), { apiVersion: "2023-05-01" });

  const subnet2 = new Subnet(mergeDefaults({
    name: `${name}/subnet-2`,
    addressPrefix: subnetPrefixes[1],
    networkSecurityGroup: {
      id: `[resourceId('Microsoft.Network/networkSecurityGroups', '${nsgName}')]`,
    },
    routeTable: {
      id: `[resourceId('Microsoft.Network/routeTables', '${routeTableName}')]`,
    },
  }, defaults?.subnet2), { apiVersion: "2023-05-01" });

  const virtualNetwork = new VirtualNetwork(mergeDefaults({
    name,
    location,
    tags: commonTags,
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
  }, defaults?.virtualNetwork), { apiVersion: "2023-05-01" });

  return { virtualNetwork, subnet1, subnet2, nsg, routeTable };
}, "VnetDefault");
