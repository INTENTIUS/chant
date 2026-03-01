/**
 * PrivateEndpoint composite — Private Endpoint + Private DNS Zone + DNS Zone Group.
 *
 * Creates a Private Endpoint for a target resource along with a Private DNS Zone
 * and DNS Zone Group for private connectivity.
 */

import { markAsAzureResource } from "./from-arm";

export interface PrivateEndpointProps {
  /** Private endpoint name. */
  name: string;
  /** Azure region (default: resource group location). */
  location?: string;
  /** Target resource ID to connect privately. */
  targetResourceId: string;
  /** The sub-resource (group ID) to connect to (e.g., "blob", "sql", "vault"). */
  groupId: string;
  /** Subnet ID where the private endpoint is placed. */
  subnetId: string;
  /** Private DNS zone name (e.g., "privatelink.blob.core.windows.net"). */
  privateDnsZoneName: string;
  /** VNet ID to link the DNS zone to. */
  vnetId: string;
  /** Resource tags. */
  tags?: Record<string, string>;
}

export interface PrivateEndpointResult {
  privateEndpoint: Record<string, unknown>;
  privateDnsZone: Record<string, unknown>;
  dnsZoneGroup: Record<string, unknown>;
  vnetLink: Record<string, unknown>;
}

export function PrivateEndpoint(props: PrivateEndpointProps): PrivateEndpointResult {
  const {
    name,
    location = "[resourceGroup().location]",
    targetResourceId,
    groupId,
    subnetId,
    privateDnsZoneName,
    vnetId,
    tags = {},
  } = props;

  const mergedTags = { "managed-by": "chant", ...tags };

  const privateEndpoint: Record<string, unknown> = {
    type: "Microsoft.Network/privateEndpoints",
    apiVersion: "2023-05-01",
    name,
    location,
    tags: mergedTags,
    properties: {
      subnet: { id: subnetId },
      privateLinkServiceConnections: [
        {
          name: `${name}-connection`,
          properties: {
            privateLinkServiceId: targetResourceId,
            groupIds: [groupId],
          },
        },
      ],
    },
  };

  const privateDnsZone: Record<string, unknown> = {
    type: "Microsoft.Network/privateDnsZones",
    apiVersion: "2020-06-01",
    name: privateDnsZoneName,
    location: "global",
    tags: mergedTags,
    properties: {},
  };

  const vnetLink: Record<string, unknown> = {
    type: "Microsoft.Network/privateDnsZones/virtualNetworkLinks",
    apiVersion: "2020-06-01",
    name: `${privateDnsZoneName}/${name}-vnet-link`,
    location: "global",
    properties: {
      virtualNetwork: { id: vnetId },
      registrationEnabled: false,
    },
    dependsOn: [
      `[resourceId('Microsoft.Network/privateDnsZones', '${privateDnsZoneName}')]`,
    ],
  };

  const dnsZoneGroup: Record<string, unknown> = {
    type: "Microsoft.Network/privateEndpoints/privateDnsZoneGroups",
    apiVersion: "2023-05-01",
    name: `${name}/${name}-dns-group`,
    properties: {
      privateDnsZoneConfigs: [
        {
          name: "config1",
          properties: {
            privateDnsZoneId: `[resourceId('Microsoft.Network/privateDnsZones', '${privateDnsZoneName}')]`,
          },
        },
      ],
    },
    dependsOn: [
      `[resourceId('Microsoft.Network/privateEndpoints', '${name}')]`,
      `[resourceId('Microsoft.Network/privateDnsZones', '${privateDnsZoneName}')]`,
    ],
  };

  markAsAzureResource(privateEndpoint);
  markAsAzureResource(privateDnsZone);
  markAsAzureResource(vnetLink);
  markAsAzureResource(dnsZoneGroup);

  return { privateEndpoint, privateDnsZone, dnsZoneGroup, vnetLink };
}
