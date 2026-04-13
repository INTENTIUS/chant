// GCP infrastructure: Global VPC with subnets in 3 regions for GKE.
// GCP VPC is global — subnets in different regions route natively. No VPN needed.

import {
  MultiRegionVpc,
  GCP,
  defaultAnnotations,
  Firewall,
} from "@intentius/chant-lexicon-gcp";
import { REGIONS, GKE_POD_CIDRS } from "../config";

export const annotations = defaultAnnotations({
  "cnrm.cloud.google.com/project-id": GCP.ProjectId,
});

// ── VPC + Subnets + Routers + NATs ─────────────────────────────────
// MultiRegionVpc creates the network, 2 subnets per region, 1 Router per region,
// and 1 RouterNAT per region — all in one call.

export const network = MultiRegionVpc({
  name: "crdb-multi-region",
  regions: [
    { region: "us-east4",    regionAlias: "east",    nodeSubnetCidr: REGIONS.east.nodeCidr,    podSubnetCidr: REGIONS.east.podCidr },
    { region: "us-central1", regionAlias: "central", nodeSubnetCidr: REGIONS.central.nodeCidr, podSubnetCidr: REGIONS.central.podCidr },
    { region: "us-west1",    regionAlias: "west",    nodeSubnetCidr: REGIONS.west.nodeCidr,    podSubnetCidr: REGIONS.west.podCidr },
  ],
});

// ── Extra firewall rule for GKE-allocated pod CIDRs ────────────────
// GKE allocates secondary IP ranges for pods that differ from the subnet CIDRs
// declared above. MultiRegionVpc's allow-internal rule only covers the configured
// subnet CIDRs. This rule adds the actual GKE pod ranges.
// Find ranges with: gcloud compute networks subnets describe <name> --region=<region>
export const firewallGkePods = new Firewall({
  metadata: {
    name: "crdb-multi-region-allow-gke-pods",
    labels: { "app.kubernetes.io/managed-by": "chant" },
  },
  networkRef: { name: "crdb-multi-region" },
  allow: [
    { protocol: "tcp", ports: ["0-65535"] },
    { protocol: "udp", ports: ["0-65535"] },
    { protocol: "icmp" },
  ],
  sourceRanges: [
    GKE_POD_CIDRS.east,
    GKE_POD_CIDRS.central,
    GKE_POD_CIDRS.west,
  ],
});
