// VPC + Cloud NAT for the Ray GKE cluster.
//
// GKE private nodes have no public IPs — Cloud NAT provides outbound internet
// access for pulling container images and contacting GCS/Artifact Registry.
// The subnet name must match config.subnetName so GkeCluster's subnetworkRef
// can resolve it via Config Connector.

import { VpcNetwork } from "@intentius/chant-lexicon-gcp";
import { config } from "../config";

export const network = VpcNetwork({
  name: config.vpcName,
  subnets: [
    // CC resource name will be ray-vpc-nodes; config.subnetName must match.
    { name: "nodes", ipCidrRange: "10.0.0.0/20", region: config.region },
  ],
  enableNat: true,
  natRegion: config.region,
  allowInternalTraffic: true,
});
