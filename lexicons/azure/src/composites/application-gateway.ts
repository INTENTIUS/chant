/**
 * ApplicationGateway composite — Public IP + Application Gateway.
 *
 * Creates a Public IP and Application Gateway with WAF_v2 default SKU
 * and TLS 1.2 policy.
 */

import { markAsAzureResource } from "./from-arm";

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
}

export interface ApplicationGatewayResult {
  publicIp: Record<string, unknown>;
  gateway: Record<string, unknown>;
}

export function ApplicationGateway(props: ApplicationGatewayProps): ApplicationGatewayResult {
  const {
    name,
    location = "[resourceGroup().location]",
    subnetId = "[resourceId('Microsoft.Network/virtualNetworks/subnets', 'vnet', 'appgw-subnet')]",
    sku = "WAF_v2",
    tags = {},
  } = props;

  const mergedTags = { "managed-by": "chant", ...tags };

  const publicIp: Record<string, unknown> = {
    type: "Microsoft.Network/publicIPAddresses",
    apiVersion: "2023-05-01",
    name: `${name}-pip`,
    location,
    tags: mergedTags,
    sku: { name: "Standard" },
    properties: {
      publicIPAllocationMethod: "Static",
    },
  };

  const gateway: Record<string, unknown> = {
    type: "Microsoft.Network/applicationGateways",
    apiVersion: "2023-05-01",
    name,
    location,
    tags: mergedTags,
    properties: {
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
    },
    dependsOn: [
      `[resourceId('Microsoft.Network/publicIPAddresses', '${name}-pip')]`,
    ],
  };

  markAsAzureResource(publicIp);
  markAsAzureResource(gateway);

  return { publicIp, gateway };
}
