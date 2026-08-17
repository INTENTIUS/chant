// Networking and cross-region discovery, for all three regions at once.
//
// GCP's VPC is global, so one network with a subnet pair per region routes
// natively — no VPN, no peering. `MultiRegionVpc` emits that whole shape:
// network, node + pod subnets per region, a Cloud Router and NAT per region,
// and an allow-internal firewall covering every declared subnet CIDR.

import {
  MultiRegionVpc,
  DNSManagedZone,
  Firewall,
  GCP,
  defaultAnnotations,
} from "@intentius/chant-lexicon-gcp";
import { GKE_POD_CIDRS, INTERNAL_DOMAIN, REGIONS } from "./config";

export const annotations = defaultAnnotations({
  "cnrm.cloud.google.com/project-id": GCP.ProjectId,
});

const NETWORK = "crdb-multi-region";

export const vpc = MultiRegionVpc({
  name: NETWORK,
  regions: [
    { region: REGIONS.east.region, regionAlias: "east", nodeSubnetCidr: REGIONS.east.nodeCidr, podSubnetCidr: REGIONS.east.podCidr },
    { region: REGIONS.central.region, regionAlias: "central", nodeSubnetCidr: REGIONS.central.nodeCidr, podSubnetCidr: REGIONS.central.podCidr },
    { region: REGIONS.west.region, regionAlias: "west", nodeSubnetCidr: REGIONS.west.nodeCidr, podSubnetCidr: REGIONS.west.podCidr },
  ],
});

// The composite's allow-internal rule covers the CIDRs it was given, which are
// the ones we declared. GKE hands pods addresses from secondary ranges of its
// own choosing, and cross-cluster gossip runs pod-to-pod — so those ranges need
// their own rule. See GKE_POD_CIDRS in ./config for how to find them.
export const firewallGkePods = new Firewall({
  metadata: { name: `${NETWORK}-allow-gke-pods` },
  networkRef: { name: NETWORK },
  allow: [
    { protocol: "tcp", ports: ["0-65535"] },
    { protocol: "udp", ports: ["0-65535"] },
    { protocol: "icmp" },
  ],
  sourceRanges: GKE_POD_CIDRS,
});

// Cross-cluster discovery. ExternalDNS in each cluster registers its pod IPs
// here (cockroachdb-0.east.crdb.internal and so on); the zone is private to
// this VPC, so all three clusters resolve each other's nodes and nobody else
// can.
export const privateDnsZone = new DNSManagedZone({
  metadata: { name: "crdb-internal" },
  dnsName: `${INTERNAL_DOMAIN}.`,
  description: "CockroachDB cross-region discovery — managed by chant",
  visibility: "private",
  privateVisibilityConfig: {
    networks: [{ networkRef: { name: NETWORK } }],
  },
});
