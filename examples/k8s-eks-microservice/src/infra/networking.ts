// AWS infrastructure: VPC with public and private subnets for EKS.
//
// Uses the VpcDefault composite which creates:
// - VPC with DNS support
// - 2 public subnets (with IGW)
// - 2 private subnets (with NAT gateway)
//
// The VPC and subnet IDs are exported for cross-stack reference in ./outputs.

import { VpcDefault } from "@intentius/chant-lexicon-aws";

export const network = VpcDefault({});
