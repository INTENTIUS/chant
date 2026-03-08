/**
 * ApplicationGateway composite — Public IP + Application Gateway.
 *
 * Creates a Public IP and Application Gateway with WAF_v2 default SKU
 * and TLS 1.2 policy.
 */

import { Composite, mergeDefaults } from "@intentius/chant";
import {
  PublicIPAddress,
  ApplicationGateway as ApplicationGatewayResource,
} from "../generated";

export interface ApplicationGatewayProps {
  /** Application Gateway name. */
  name: string;
  /** Azure region (default: resource group location). */
  location?: string;
  /** Subnet ID for the gateway (required for production — defaults to placeholder). */
  subnetId?: string;
  /** SKU name (default: "WAF_v2"). */
  sku?: string;
  /** Resource tags. */
  tags?: Record<string, string>;
  /** Per-member defaults. */
  defaults?: {
    publicIp?: Partial<ConstructorParameters<typeof PublicIPAddress>[0]>;
    gateway?: Partial<ConstructorParameters<typeof ApplicationGatewayResource>[0]>;
  };
}

export interface ApplicationGatewayResult {
  publicIp: InstanceType<typeof PublicIPAddress>;
  gateway: InstanceType<typeof ApplicationGatewayResource>;
}

export const ApplicationGateway = Composite<ApplicationGatewayProps>((props) => {
  const {
    name,
    location = "[resourceGroup().location]",
    subnetId = "[resourceId('Microsoft.Network/virtualNetworks/subnets', 'vnet', 'appgw-subnet')]",
    sku = "WAF_v2",
    tags = {},
    defaults,
  } = props;

  const mergedTags = { "managed-by": "chant", ...tags };

  const publicIp = new PublicIPAddress(mergeDefaults({
    name: `${name}-pip`,
    location,
    tags: mergedTags,
    sku: { name: "Standard" },
    publicIPAllocationMethod: "Static",
  }, defaults?.publicIp), { apiVersion: "2023-05-01" });

  const gateway = new ApplicationGatewayResource(mergeDefaults({
    name,
    location,
    tags: mergedTags,
    sku: {
      name: sku,
      tier: sku,
      capacity: 2,
    },
    sslPolicy: {
      policyType: "Predefined",
      policyName: "AppGwSslPolicy20220101",
      minProtocolVersion: "TLSv1_2",
    },
    gatewayIPConfigurations: [
      {
        name: "appGatewayIpConfig",
        properties: {
          subnet: { id: subnetId },
        },
      },
    ],
    frontendIPConfigurations: [
      {
        name: "appGwPublicFrontendIp",
        properties: {
          publicIPAddress: {
            id: `[resourceId('Microsoft.Network/publicIPAddresses', '${name}-pip')]`,
          },
        },
      },
    ],
    frontendPorts: [
      { name: "port_80", properties: { port: 80 } },
    ],
    backendAddressPools: [
      { name: "defaultBackendPool", properties: {} },
    ],
    backendHttpSettingsCollection: [
      {
        name: "defaultHttpSettings",
        properties: {
          port: 80,
          protocol: "Http",
          cookieBasedAffinity: "Disabled",
          requestTimeout: 30,
        },
      },
    ],
    httpListeners: [
      {
        name: "defaultListener",
        properties: {
          frontendIPConfiguration: {
            id: `[concat(resourceId('Microsoft.Network/applicationGateways', '${name}'), '/frontendIPConfigurations/appGwPublicFrontendIp')]`,
          },
          frontendPort: {
            id: `[concat(resourceId('Microsoft.Network/applicationGateways', '${name}'), '/frontendPorts/port_80')]`,
          },
          protocol: "Http",
        },
      },
    ],
    requestRoutingRules: [
      {
        name: "defaultRule",
        properties: {
          ruleType: "Basic",
          priority: 100,
          httpListener: {
            id: `[concat(resourceId('Microsoft.Network/applicationGateways', '${name}'), '/httpListeners/defaultListener')]`,
          },
          backendAddressPool: {
            id: `[concat(resourceId('Microsoft.Network/applicationGateways', '${name}'), '/backendAddressPools/defaultBackendPool')]`,
          },
          backendHttpSettings: {
            id: `[concat(resourceId('Microsoft.Network/applicationGateways', '${name}'), '/backendHttpSettingsCollection/defaultHttpSettings')]`,
          },
        },
      },
    ],
  }, defaults?.gateway), {
    apiVersion: "2023-05-01",
    DependsOn: [
      `[resourceId('Microsoft.Network/publicIPAddresses', '${name}-pip')]`,
    ],
  });

  return { publicIp, gateway };
}, "ApplicationGateway");
