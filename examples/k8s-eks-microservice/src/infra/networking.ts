// AWS infrastructure: VPC with public and private subnets for EKS.
//
// Uses the VpcDefault composite which creates:
// - VPC with DNS support
// - 2 public subnets (with IGW)
// - 2 private subnets (with NAT gateway)

import { VpcDefault, stackOutput } from "@intentius/chant-lexicon-aws";

export const network = VpcDefault({});

// Export VPC and subnet IDs for cross-stack reference
export const vpcId = stackOutput(network.vpc.VpcId, {
  description: "VPC ID for EKS cluster",
});

export const publicSubnet1Id = stackOutput(network.publicSubnet1.SubnetId, {
  description: "Public subnet 1 for ALB",
});

export const publicSubnet2Id = stackOutput(network.publicSubnet2.SubnetId, {
  description: "Public subnet 2 for ALB",
});

export const privateSubnet1Id = stackOutput(network.privateSubnet1.SubnetId, {
  description: "Private subnet 1 for EKS nodes",
});

export const privateSubnet2Id = stackOutput(network.privateSubnet2.SubnetId, {
  description: "Private subnet 2 for EKS nodes",
});
