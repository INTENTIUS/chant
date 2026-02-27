/**
 * VPC Network with subnets, firewall rules, and Cloud NAT.
 */

import { VpcNetwork, GCP } from "@intentius/chant-lexicon-gcp";
import { defaultAnnotations } from "@intentius/chant-lexicon-gcp";

export const annotations = defaultAnnotations({
  "cnrm.cloud.google.com/project-id": GCP.ProjectId,
});

export const { network, subnets, firewalls, router, routerNat } = VpcNetwork({
  name: "prod-vpc",
  subnets: [
    { name: "app", ipCidrRange: "10.0.0.0/24", region: "us-central1" },
    { name: "data", ipCidrRange: "10.0.1.0/24", region: "us-central1" },
    { name: "gke", ipCidrRange: "10.0.2.0/22", region: "us-central1" },
  ],
  enableNat: true,
  natRegion: "us-central1",
  allowIapSsh: true,
});
