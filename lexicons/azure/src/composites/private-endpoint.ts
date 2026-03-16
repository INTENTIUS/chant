/**
 * PrivateEndpoint composite — Private Endpoint + Private DNS Zone + DNS Zone Group.
 *
 * Creates a Private Endpoint for a target resource along with a Private DNS Zone
 * and DNS Zone Group for private connectivity.
 */

import { Composite, mergeDefaults } from "@intentius/chant";
import {
  privateEndpoints,
  PrivateDnsZone,
  privateEndpoints_privateDnsZoneGroups,
  privateDnsZones_virtualNetworkLinks,
} from "../generated";

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
  /** Per-member defaults. */
  defaults?: {
    privateEndpoint?: Partial<ConstructorParameters<typeof privateEndpoints>[0]>;
    privateDnsZone?: Partial<ConstructorParameters<typeof PrivateDnsZone>[0]>;
    dnsZoneGroup?: Partial<ConstructorParameters<typeof privateEndpoints_privateDnsZoneGroups>[0]>;
    vnetLink?: Partial<ConstructorParameters<typeof privateDnsZones_virtualNetworkLinks>[0]>;
  };
}

export interface PrivateEndpointResult {
  privateEndpoint: InstanceType<typeof privateEndpoints>;
  privateDnsZone: InstanceType<typeof PrivateDnsZone>;
  dnsZoneGroup: InstanceType<typeof privateEndpoints_privateDnsZoneGroups>;
  vnetLink: InstanceType<typeof privateDnsZones_virtualNetworkLinks>;
}

export const PrivateEndpoint = Composite<PrivateEndpointProps>((props) => {
  const {
    name,
    location = "[resourceGroup().location]",
    targetResourceId,
    groupId,
    subnetId,
    privateDnsZoneName,
    vnetId,
    tags = {},
    defaults,
  } = props;

  const mergedTags = { "managed-by": "chant", ...tags };

  const privateEndpoint = new privateEndpoints(mergeDefaults({
    name,
    location,
    tags: mergedTags,
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
  }, defaults?.privateEndpoint), { apiVersion: "2023-05-01" });

  const privateDnsZone = new PrivateDnsZone(mergeDefaults({
    name: privateDnsZoneName,
    location: "global",
    tags: mergedTags,
  }, defaults?.privateDnsZone), { apiVersion: "2020-06-01" });

  const vnetLink = new privateDnsZones_virtualNetworkLinks(mergeDefaults({
    name: `${privateDnsZoneName}/${name}-vnet-link`,
    location: "global",
    virtualNetwork: { id: vnetId },
    registrationEnabled: false,
  }, defaults?.vnetLink), {
    apiVersion: "2020-06-01",
    DependsOn: [
      `[resourceId('Microsoft.Network/privateDnsZones', '${privateDnsZoneName}')]`,
    ],
  });

  const dnsZoneGroup = new privateEndpoints_privateDnsZoneGroups(mergeDefaults({
    name: `${name}/${name}-dns-group`,
    privateDnsZoneConfigs: [
      {
        name: "config1",
        properties: {
          privateDnsZoneId: `[resourceId('Microsoft.Network/privateDnsZones', '${privateDnsZoneName}')]`,
        },
      },
    ],
  }, defaults?.dnsZoneGroup), {
    apiVersion: "2023-05-01",
    DependsOn: [
      `[resourceId('Microsoft.Network/privateEndpoints', '${name}')]`,
      `[resourceId('Microsoft.Network/privateDnsZones', '${privateDnsZoneName}')]`,
    ],
  });

  return { privateEndpoint, privateDnsZone, dnsZoneGroup, vnetLink };
}, "PrivateEndpoint");
