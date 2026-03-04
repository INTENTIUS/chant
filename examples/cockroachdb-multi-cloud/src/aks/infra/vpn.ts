// Azure infrastructure: VPN gateway + connections to AWS and GCP.
// Full mesh VPN: Azure ↔ AWS, Azure ↔ GCP.

import {
  virtualNetworkGateways,
  localNetworkGateways,
  Networkconnections,
  PublicIPAddress,
  Azure,
} from "@intentius/chant-lexicon-azure";
import { CIDRS } from "../../shared/config";

// VPN public IPs from peer clouds — populated after their infra deploys.
const awsVpnIp = process.env.AWS_VPN_PUBLIC_IP ?? "0.0.0.0";
const gcpVpnIp = process.env.GCP_VPN_PUBLIC_IP ?? "0.0.0.0";
const vpnSharedSecret = process.env.VPN_SHARED_SECRET ?? "changeme";

// ── Public IP for VPN Gateway ───────────────────────────────────────

export const vpnPublicIp = new PublicIPAddress({
  name: "aks-cockroachdb-vpn-ip",
  location: Azure.ResourceGroupLocation as unknown as string,
  properties: {
    publicIPAllocationMethod: "Static",
  },
  sku: { name: "Standard" },
  tags: { "managed-by": "chant" },
});

// ── Virtual Network Gateway ─────────────────────────────────────────

export const vpnGateway = new virtualNetworkGateways({
  name: "aks-cockroachdb-vpn-gw",
  location: Azure.ResourceGroupLocation as unknown as string,
  properties: {
    gatewayType: "Vpn",
    vpnType: "RouteBased",
    sku: { name: "VpnGw1", tier: "VpnGw1" },
    ipConfigurations: [
      {
        name: "default",
        properties: {
          publicIPAddress: { id: "[resourceId('Microsoft.Network/publicIPAddresses', 'aks-cockroachdb-vpn-ip')]" },
          subnet: { id: "[resourceId('Microsoft.Network/virtualNetworks/subnets', 'aks-cockroachdb-vnet', 'GatewaySubnet')]" },
        },
      },
    ],
  },
  tags: { "managed-by": "chant" },
});

// ── Azure ↔ AWS local network gateway + connection ──────────────────

export const awsLocalGw = new localNetworkGateways({
  name: "aws-peer",
  location: Azure.ResourceGroupLocation as unknown as string,
  properties: {
    gatewayIpAddress: awsVpnIp,
    localNetworkAddressSpace: {
      addressPrefixes: [CIDRS.eks.vpc],
    },
  },
  tags: { "managed-by": "chant" },
});

// ── Azure ↔ AWS VPN connection ───────────────────────────────────────

export const awsConnection = new Networkconnections({
  name: "azure-to-aws",
  location: Azure.ResourceGroupLocation as unknown as string,
  properties: {
    connectionType: "IPsec",
    virtualNetworkGateway1: {
      id: "[resourceId('Microsoft.Network/virtualNetworkGateways', 'aks-cockroachdb-vpn-gw')]",
      properties: {},
    },
    localNetworkGateway2: {
      id: "[resourceId('Microsoft.Network/localNetworkGateways', 'aws-peer')]",
      properties: {},
    },
    sharedKey: vpnSharedSecret,
    routingWeight: 10,
  },
  tags: { "managed-by": "chant" },
});

// ── Azure ↔ GCP local network gateway + connection ──────────────────

export const gcpLocalGw = new localNetworkGateways({
  name: "gcp-peer",
  location: Azure.ResourceGroupLocation as unknown as string,
  properties: {
    gatewayIpAddress: gcpVpnIp,
    localNetworkAddressSpace: {
      addressPrefixes: [CIDRS.gke.vpc],
    },
  },
  tags: { "managed-by": "chant" },
});

// ── Azure ↔ GCP VPN connection ──────────────────────────────────────

export const gcpConnection = new Networkconnections({
  name: "azure-to-gcp",
  location: Azure.ResourceGroupLocation as unknown as string,
  properties: {
    connectionType: "IPsec",
    virtualNetworkGateway1: {
      id: "[resourceId('Microsoft.Network/virtualNetworkGateways', 'aks-cockroachdb-vpn-gw')]",
      properties: {},
    },
    localNetworkGateway2: {
      id: "[resourceId('Microsoft.Network/localNetworkGateways', 'gcp-peer')]",
      properties: {},
    },
    sharedKey: vpnSharedSecret,
    routingWeight: 10,
  },
  tags: { "managed-by": "chant" },
});
