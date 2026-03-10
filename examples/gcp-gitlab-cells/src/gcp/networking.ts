import { VpcNetwork, PrivateService } from "@intentius/chant-lexicon-gcp";
import { shared } from "../config";

export const network = VpcNetwork({
  name: shared.clusterName,
  subnets: [
    {
      name: "nodes",
      ipCidrRange: shared.nodeSubnetCidr,
      region: shared.region,
      secondaryIpRanges: [
        { rangeName: "pods", ipCidrRange: shared.podSubnetCidr },
        { rangeName: "services", ipCidrRange: shared.serviceSubnetCidr },
      ],
    },
  ],
  enableNat: true,
  natRegion: shared.region,
  allowInternalTraffic: true,
  allowIapSsh: true,
});

// VPC peering for Cloud SQL + Memorystore private IP access
export const privateServices = PrivateService({
  name: "gitlab-cells-private",
  networkName: shared.clusterName,
  prefixLength: 16,
  defaults: {
    globalAddress: { location: "global" },
  },
});
