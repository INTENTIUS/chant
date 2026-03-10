// GCP infrastructure: Global VPC with subnets in 3 regions for GKE.
// GCP VPC is global — subnets in different regions route natively. No VPN needed.

import {
  VpcNetwork,
  Router,
  RouterNAT,
  GCP,
  defaultAnnotations,
} from "@intentius/chant-lexicon-gcp";
import { REGIONS } from "../config";

export const annotations = defaultAnnotations({
  "cnrm.cloud.google.com/project-id": GCP.ProjectId,
});

// ── VPC + Subnets ──────────────────────────────────────────────────
// One global VPC with 6 subnets (nodes + pods per region).
// VpcNetwork composite handles NAT for one region; we add NAT for the other two manually.

export const network = VpcNetwork({
  name: "crdb-multi-region",
  subnets: [
    { name: "east-nodes", ipCidrRange: REGIONS.east.nodeCidr, region: "us-east4" },
    { name: "east-pods", ipCidrRange: REGIONS.east.podCidr, region: "us-east4" },
    { name: "central-nodes", ipCidrRange: REGIONS.central.nodeCidr, region: "us-central1" },
    { name: "central-pods", ipCidrRange: REGIONS.central.podCidr, region: "us-central1" },
    { name: "west-nodes", ipCidrRange: REGIONS.west.nodeCidr, region: "us-west1" },
    { name: "west-pods", ipCidrRange: REGIONS.west.podCidr, region: "us-west1" },
  ],
  enableNat: true,
  natRegion: "us-east4",
  allowInternalTraffic: true,
});

// ── Cloud NAT for us-central1 ──────────────────────────────────────

export const centralRouter = new Router({
  metadata: {
    name: "crdb-multi-region-central",
    labels: { "app.kubernetes.io/managed-by": "chant" },
  },
  region: "us-central1",
  networkRef: { name: "crdb-multi-region" },
});

export const centralNat = new RouterNAT({
  metadata: {
    name: "crdb-multi-region-central",
    labels: { "app.kubernetes.io/managed-by": "chant" },
  },
  region: "us-central1",
  routerRef: { name: "crdb-multi-region-central" },
  natIpAllocateOption: "AUTO_ONLY",
  sourceSubnetworkIpRangesToNat: "ALL_SUBNETWORKS_ALL_PRIMARY_IP_RANGES",
});

// ── Cloud NAT for us-west1 ─────────────────────────────────────────

export const westRouter = new Router({
  metadata: {
    name: "crdb-multi-region-west",
    labels: { "app.kubernetes.io/managed-by": "chant" },
  },
  region: "us-west1",
  networkRef: { name: "crdb-multi-region" },
});

export const westNat = new RouterNAT({
  metadata: {
    name: "crdb-multi-region-west",
    labels: { "app.kubernetes.io/managed-by": "chant" },
  },
  region: "us-west1",
  routerRef: { name: "crdb-multi-region-west" },
  natIpAllocateOption: "AUTO_ONLY",
  sourceSubnetworkIpRangesToNat: "ALL_SUBNETWORKS_ALL_PRIMARY_IP_RANGES",
});
