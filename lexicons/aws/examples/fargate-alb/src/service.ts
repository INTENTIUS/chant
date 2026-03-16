import { FargateAlb } from "@intentius/chant-lexicon-aws";
import { network } from "./network";

export const web = FargateAlb({
  image: "nginx:latest",
  vpcId: network.vpc.VpcId,
  publicSubnetIds: [network.publicSubnet1.SubnetId, network.publicSubnet2.SubnetId],
  privateSubnetIds: [network.privateSubnet1.SubnetId, network.privateSubnet2.SubnetId],
});
