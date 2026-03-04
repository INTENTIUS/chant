// GCP infrastructure: VPC (10.3.0.0/16) with subnets for GKE.
// Firewall rules allow CockroachDB ports from AWS and Azure VPN peers.

import {
  VpcNetwork,
  Firewall,
  ComputeAddress,
  GCP,
  defaultAnnotations,
} from "@intentius/chant-lexicon-gcp";
import { CIDRS } from "../../shared/config";

export const annotations = defaultAnnotations({
  "cnrm.cloud.google.com/project-id": GCP.ProjectId,
});

// ── VPC ─────────────────────────────────────────────────────────────

export const network = VpcNetwork({
  name: "gke-cockroachdb",
  subnets: [
    { name: "nodes", ipCidrRange: "10.3.0.0/20", region: "us-east4" },
    { name: "pods", ipCidrRange: "10.3.128.0/17", region: "us-east4" },
  ],
  enableNat: true,
  natRegion: "us-east4",
  allowInternalTraffic: true,
});

// ── Static IP for GCE Ingress (CockroachDB UI) ────────────────────

export const uiStaticIp = new ComputeAddress({
  metadata: {
    name: "cockroachdb-ui-ip",
    labels: { "app.kubernetes.io/managed-by": "chant" },
  },
  addressType: "EXTERNAL",
  location: "us-east4",
  description: "Static IP for CockroachDB UI GCE Ingress",
});

// ── CockroachDB cross-cloud firewall rules ─────────────────────────

export const crdbFromAws = new Firewall({
  metadata: {
    name: "allow-crdb-from-aws",
    labels: { "app.kubernetes.io/managed-by": "chant" },
  },
  networkRef: { name: "gke-cockroachdb" },
  allow: [
    { protocol: "tcp", ports: ["26257", "8080"] },
  ],
  sourceRanges: [CIDRS.eks.vpc],
  description: "CockroachDB gRPC+HTTP from AWS VPC",
});

export const crdbFromAzure = new Firewall({
  metadata: {
    name: "allow-crdb-from-azure",
    labels: { "app.kubernetes.io/managed-by": "chant" },
  },
  networkRef: { name: "gke-cockroachdb" },
  allow: [
    { protocol: "tcp", ports: ["26257", "8080"] },
  ],
  sourceRanges: [CIDRS.aks.vpc],
  description: "CockroachDB gRPC+HTTP from Azure VNet",
});
