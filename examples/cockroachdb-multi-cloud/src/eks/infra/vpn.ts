// AWS infrastructure: VPN gateway + connections to Azure and GCP.
// Full mesh VPN: AWS ↔ Azure, AWS ↔ GCP (Azure ↔ GCP handled on their side).

import {
  VPNGateway,
  VPCGatewayAttachment,
  CustomerGateway,
  VPNConnection,
  stackOutput,
} from "@intentius/chant-lexicon-aws";
import { network } from "./networking";

// VPN public IPs from peer clouds — populated after their infra deploys.
const azureVpnIp = process.env.AZURE_VPN_PUBLIC_IP ?? "0.0.0.0";
const gcpVpnIp = process.env.GCP_VPN_PUBLIC_IP ?? "0.0.0.0";
const vpnSharedSecret = process.env.VPN_SHARED_SECRET ?? "changeme";

// ── VPN Gateway ─────────────────────────────────────────────────────

export const vpnGateway = new VPNGateway({
  Type: "ipsec.1",
  Tags: [{ Key: "Name", Value: "eks-cockroachdb-vpn-gw" }],
});

export const vpnAttachment = new VPCGatewayAttachment({
  VpcId: network.vpc.VpcId,
  VpnGatewayId: vpnGateway.VPNGatewayId,
});

// ── AWS ↔ Azure VPN ────────────────────────────────────────────────

export const azureCustomerGw = new CustomerGateway({
  Type: "ipsec.1",
  BgpAsn: "65515",
  IpAddress: azureVpnIp,
  Tags: [{ Key: "Name", Value: "azure-peer" }],
});

export const azureVpnConnection = new VPNConnection({
  Type: "ipsec.1",
  CustomerGatewayId: azureCustomerGw.CustomerGatewayId,
  VpnGatewayId: vpnGateway.VPNGatewayId,
  VpnTunnelOptionsSpecifications: [
    { PreSharedKey: vpnSharedSecret },
    { PreSharedKey: vpnSharedSecret },
  ],
  Tags: [{ Key: "Name", Value: "aws-to-azure" }],
});

// ── AWS ↔ GCP VPN ──────────────────────────────────────────────────

export const gcpCustomerGw = new CustomerGateway({
  Type: "ipsec.1",
  BgpAsn: "65003",
  IpAddress: gcpVpnIp,
  Tags: [{ Key: "Name", Value: "gcp-peer" }],
});

export const gcpVpnConnection = new VPNConnection({
  Type: "ipsec.1",
  CustomerGatewayId: gcpCustomerGw.CustomerGatewayId,
  VpnGatewayId: vpnGateway.VPNGatewayId,
  VpnTunnelOptionsSpecifications: [
    { PreSharedKey: vpnSharedSecret },
    { PreSharedKey: vpnSharedSecret },
  ],
  Tags: [{ Key: "Name", Value: "aws-to-gcp" }],
});

// ── Stack Outputs ──────────────────────────────────────────────────

export const vpnGatewayId = stackOutput(vpnGateway.VPNGatewayId, {
  description: "VPN Gateway ID for cross-cloud connectivity",
});
