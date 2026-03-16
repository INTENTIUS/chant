/**
 * VPC Network with subnets, firewall rules, and Cloud NAT.
 */

import {
  VPC, Subnetwork, Firewall, Router, RouterNAT,
  GCP, defaultAnnotations,
} from "@intentius/chant-lexicon-gcp";

export const annotations = defaultAnnotations({
  "cnrm.cloud.google.com/project-id": GCP.ProjectId,
});

export const network = new VPC({
  metadata: {
    name: "prod-vpc",
    labels: { "app.kubernetes.io/managed-by": "chant" },
  },
  autoCreateSubnetworks: false,
  routingMode: "REGIONAL",
});

export const appSubnet = new Subnetwork({
  metadata: {
    name: "prod-vpc-app",
    labels: { "app.kubernetes.io/managed-by": "chant" },
  },
  networkRef: { name: "prod-vpc" },
  ipCidrRange: "10.0.0.0/24",
  region: "us-central1",
  privateIpGoogleAccess: true,
});

export const dataSubnet = new Subnetwork({
  metadata: {
    name: "prod-vpc-data",
    labels: { "app.kubernetes.io/managed-by": "chant" },
  },
  networkRef: { name: "prod-vpc" },
  ipCidrRange: "10.0.1.0/24",
  region: "us-central1",
  privateIpGoogleAccess: true,
});

export const gkeSubnet = new Subnetwork({
  metadata: {
    name: "prod-vpc-gke",
    labels: { "app.kubernetes.io/managed-by": "chant" },
  },
  networkRef: { name: "prod-vpc" },
  ipCidrRange: "10.0.2.0/22",
  region: "us-central1",
  privateIpGoogleAccess: true,
});

export const allowInternal = new Firewall({
  metadata: {
    name: "prod-vpc-allow-internal",
    labels: { "app.kubernetes.io/managed-by": "chant" },
  },
  networkRef: { name: "prod-vpc" },
  allow: [
    { protocol: "tcp", ports: ["0-65535"] },
    { protocol: "udp", ports: ["0-65535"] },
    { protocol: "icmp" },
  ],
  sourceRanges: ["10.0.0.0/24", "10.0.1.0/24", "10.0.2.0/22"],
});

export const allowIapSsh = new Firewall({
  metadata: {
    name: "prod-vpc-allow-iap-ssh",
    labels: { "app.kubernetes.io/managed-by": "chant" },
  },
  networkRef: { name: "prod-vpc" },
  allow: [{ protocol: "tcp", ports: ["22"] }],
  sourceRanges: ["35.235.240.0/20"],
});

export const router = new Router({
  metadata: {
    name: "prod-vpc-router",
    labels: { "app.kubernetes.io/managed-by": "chant" },
  },
  networkRef: { name: "prod-vpc" },
  region: "us-central1",
});

export const nat = new RouterNAT({
  metadata: {
    name: "prod-vpc-nat",
    labels: { "app.kubernetes.io/managed-by": "chant" },
  },
  routerRef: { name: "prod-vpc-router" },
  region: "us-central1",
  natIpAllocateOption: "AUTO_ONLY",
  sourceSubnetworkIpRangesToNat: "ALL_SUBNETWORKS_ALL_IP_RANGES",
});
