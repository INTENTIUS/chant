import { AlbShared } from "@intentius/chant-lexicon-aws";
import { network } from "./network";

// The shared ALB + listener + ECS cluster + execution role every service attaches to.
export const shared = AlbShared({
  vpcId: network.vpc.VpcId,
  publicSubnetIds: [network.publicSubnet1.SubnetId, network.publicSubnet2.SubnetId],
});
