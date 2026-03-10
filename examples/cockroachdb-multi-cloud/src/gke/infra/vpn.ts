// GCP infrastructure: HA VPN gateway + connections to AWS and Azure.
// Uses Cloud Router for BGP-based dynamic routing over VPN tunnels.

import {
  VPNGateway,
  ExternalVPNGateway,
  VPNTunnel,
  Router,
  RouterInterface,
  RouterPeer,
} from "@intentius/chant-lexicon-gcp";
import { CIDRS } from "../../shared/config";

// VPN public IPs from peer clouds — populated after their infra deploys.
const awsVpnIp = process.env.AWS_VPN_PUBLIC_IP ?? "0.0.0.0";
const azureVpnIp = process.env.AZURE_VPN_PUBLIC_IP ?? "0.0.0.0";
const vpnSharedSecret = process.env.VPN_SHARED_SECRET ?? "changeme";

// ── Cloud Router ────────────────────────────────────────────────────

export const cloudRouter = new Router({
  metadata: {
    name: "gke-cockroachdb-router",
    labels: { "app.kubernetes.io/managed-by": "chant" },
  },
  networkRef: { name: "gke-cockroachdb" },
  region: "us-east4",
  bgp: { asn: 65003 },
});

// ── HA VPN Gateway ──────────────────────────────────────────────────

export const vpnGateway = new VPNGateway({
  metadata: {
    name: "gke-cockroachdb-vpn-gw",
    labels: { "app.kubernetes.io/managed-by": "chant" },
  },
  networkRef: { name: "gke-cockroachdb" },
  region: "us-east4",
});

// ── GCP ↔ AWS VPN ──────────────────────────────────────────────────

export const awsExternalGw = new ExternalVPNGateway({
  metadata: {
    name: "aws-peer",
    labels: { "app.kubernetes.io/managed-by": "chant" },
  },
  redundancyType: "SINGLE_IP_INTERNALLY_REDUNDANT",
  interface: [{ index: 0, ipAddress: awsVpnIp }],
});

export const awsTunnel0 = new VPNTunnel({
  metadata: {
    name: "gcp-to-aws-0",
    labels: { "app.kubernetes.io/managed-by": "chant" },
  },
  region: "us-east4",
  vpnGatewayRef: { name: "gke-cockroachdb-vpn-gw" },
  peerExternalGatewayRef: { name: "aws-peer" },
  peerExternalGatewayInterface: 0,
  vpnGatewayInterface: 0,
  routerRef: { name: "gke-cockroachdb-router" },
  sharedSecret: vpnSharedSecret,
});

export const awsTunnel1 = new VPNTunnel({
  metadata: {
    name: "gcp-to-aws-1",
    labels: { "app.kubernetes.io/managed-by": "chant" },
  },
  region: "us-east4",
  vpnGatewayRef: { name: "gke-cockroachdb-vpn-gw" },
  peerExternalGatewayRef: { name: "aws-peer" },
  peerExternalGatewayInterface: 0,
  vpnGatewayInterface: 1,
  routerRef: { name: "gke-cockroachdb-router" },
  sharedSecret: vpnSharedSecret,
});

export const awsRouterIface0 = new RouterInterface({
  metadata: {
    name: "gcp-to-aws-iface-0",
    labels: { "app.kubernetes.io/managed-by": "chant" },
  },
  routerRef: { name: "gke-cockroachdb-router" },
  region: "us-east4",
  vpnTunnelRef: { name: "gcp-to-aws-0" },
  ipRange: "169.254.0.1/30",
});

export const awsRouterPeer0 = new RouterPeer({
  metadata: {
    name: "gcp-to-aws-peer-0",
    labels: { "app.kubernetes.io/managed-by": "chant" },
  },
  routerRef: { name: "gke-cockroachdb-router" },
  region: "us-east4",
  peerAsn: 64512,
  peerIpAddress: "169.254.0.2",
  advertisedRoutePriority: 100,
  routerInterfaceRef: { name: "gcp-to-aws-iface-0" },
});

export const awsRouterIface1 = new RouterInterface({
  metadata: {
    name: "gcp-to-aws-iface-1",
    labels: { "app.kubernetes.io/managed-by": "chant" },
  },
  routerRef: { name: "gke-cockroachdb-router" },
  region: "us-east4",
  vpnTunnelRef: { name: "gcp-to-aws-1" },
  ipRange: "169.254.0.5/30",
});

export const awsRouterPeer1 = new RouterPeer({
  metadata: {
    name: "gcp-to-aws-peer-1",
    labels: { "app.kubernetes.io/managed-by": "chant" },
  },
  routerRef: { name: "gke-cockroachdb-router" },
  region: "us-east4",
  peerAsn: 64512,
  peerIpAddress: "169.254.0.6",
  advertisedRoutePriority: 100,
  routerInterfaceRef: { name: "gcp-to-aws-iface-1" },
});

// ── GCP ↔ Azure VPN ────────────────────────────────────────────────

export const azureExternalGw = new ExternalVPNGateway({
  metadata: {
    name: "azure-peer",
    labels: { "app.kubernetes.io/managed-by": "chant" },
  },
  redundancyType: "SINGLE_IP_INTERNALLY_REDUNDANT",
  interface: [{ index: 0, ipAddress: azureVpnIp }],
});

export const azureTunnel0 = new VPNTunnel({
  metadata: {
    name: "gcp-to-azure-0",
    labels: { "app.kubernetes.io/managed-by": "chant" },
  },
  region: "us-east4",
  vpnGatewayRef: { name: "gke-cockroachdb-vpn-gw" },
  peerExternalGatewayRef: { name: "azure-peer" },
  peerExternalGatewayInterface: 0,
  vpnGatewayInterface: 0,
  routerRef: { name: "gke-cockroachdb-router" },
  sharedSecret: vpnSharedSecret,
});

export const azureTunnel1 = new VPNTunnel({
  metadata: {
    name: "gcp-to-azure-1",
    labels: { "app.kubernetes.io/managed-by": "chant" },
  },
  region: "us-east4",
  vpnGatewayRef: { name: "gke-cockroachdb-vpn-gw" },
  peerExternalGatewayRef: { name: "azure-peer" },
  peerExternalGatewayInterface: 0,
  vpnGatewayInterface: 1,
  routerRef: { name: "gke-cockroachdb-router" },
  sharedSecret: vpnSharedSecret,
});

export const azureRouterIface0 = new RouterInterface({
  metadata: {
    name: "gcp-to-azure-iface-0",
    labels: { "app.kubernetes.io/managed-by": "chant" },
  },
  routerRef: { name: "gke-cockroachdb-router" },
  region: "us-east4",
  vpnTunnelRef: { name: "gcp-to-azure-0" },
  ipRange: "169.254.1.1/30",
});

export const azureRouterPeer0 = new RouterPeer({
  metadata: {
    name: "gcp-to-azure-peer-0",
    labels: { "app.kubernetes.io/managed-by": "chant" },
  },
  routerRef: { name: "gke-cockroachdb-router" },
  region: "us-east4",
  peerAsn: 65515,
  peerIpAddress: "169.254.1.2",
  advertisedRoutePriority: 100,
  routerInterfaceRef: { name: "gcp-to-azure-iface-0" },
});

export const azureRouterIface1 = new RouterInterface({
  metadata: {
    name: "gcp-to-azure-iface-1",
    labels: { "app.kubernetes.io/managed-by": "chant" },
  },
  routerRef: { name: "gke-cockroachdb-router" },
  region: "us-east4",
  vpnTunnelRef: { name: "gcp-to-azure-1" },
  ipRange: "169.254.1.5/30",
});

export const azureRouterPeer1 = new RouterPeer({
  metadata: {
    name: "gcp-to-azure-peer-1",
    labels: { "app.kubernetes.io/managed-by": "chant" },
  },
  routerRef: { name: "gke-cockroachdb-router" },
  region: "us-east4",
  peerAsn: 65515,
  peerIpAddress: "169.254.1.6",
  advertisedRoutePriority: 100,
  routerInterfaceRef: { name: "gcp-to-azure-iface-1" },
});
