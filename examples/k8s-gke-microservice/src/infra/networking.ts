// GCP infrastructure: VPC with subnets for GKE.
//
// Uses the VpcNetwork composite which creates:
// - VPC with custom-mode networking
// - 2 subnets with private Google access
// - Internal traffic firewall rule
// - Cloud NAT for outbound internet access

import { VpcNetwork, GCP } from "@intentius/chant-lexicon-gcp";
import { defaultAnnotations } from "@intentius/chant-lexicon-gcp";

export const annotations = defaultAnnotations({
  "cnrm.cloud.google.com/project-id": GCP.ProjectId,
});

export const network = VpcNetwork({
  name: "gke-microservice",
  subnets: [
    { name: "nodes", ipCidrRange: "10.0.0.0/20", region: "us-central1" },
    { name: "pods", ipCidrRange: "10.4.0.0/14", region: "us-central1" },
  ],
  enableNat: true,
  natRegion: "us-central1",
  allowInternalTraffic: true,
  allowIapSsh: true,
});
