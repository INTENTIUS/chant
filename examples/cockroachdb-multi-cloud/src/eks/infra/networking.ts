// AWS infrastructure: VPC (10.1.0.0/16) with subnets for EKS.
// Security groups allow CockroachDB ports from Azure and GCP VPN peers.

import {
  VpcDefault,
  SecurityGroup,
  EC2SecurityGroupIngress,
  stackOutput,
} from "@intentius/chant-lexicon-aws";
import { CIDRS } from "../../shared/config";

// ── VPC ─────────────────────────────────────────────────────────────

export const network = VpcDefault({
  vpcCidr: "10.1.0.0/16",
});

// ── CockroachDB cross-cloud security group ─────────────────────────

export const crdbSg = new SecurityGroup({
  GroupDescription: "CockroachDB cross-cloud traffic (gRPC + HTTP)",
  VpcId: network.vpc.VpcId,
  Tags: [{ Key: "Name", Value: "crdb-cross-cloud" }],
});

// Allow CockroachDB gRPC (26257) from Azure VNet
export const grpcFromAzure = new EC2SecurityGroupIngress({
  GroupId: crdbSg.GroupId,
  IpProtocol: "tcp",
  FromPort: 26257,
  ToPort: 26257,
  CidrIp: CIDRS.aks.vpc,
  Description: "CockroachDB gRPC from Azure VNet",
});

// Allow CockroachDB gRPC (26257) from GCP VPC
export const grpcFromGcp = new EC2SecurityGroupIngress({
  GroupId: crdbSg.GroupId,
  IpProtocol: "tcp",
  FromPort: 26257,
  ToPort: 26257,
  CidrIp: CIDRS.gke.vpc,
  Description: "CockroachDB gRPC from GCP VPC",
});

// Allow CockroachDB HTTP (8080) from Azure VNet
export const httpFromAzure = new EC2SecurityGroupIngress({
  GroupId: crdbSg.GroupId,
  IpProtocol: "tcp",
  FromPort: 8080,
  ToPort: 8080,
  CidrIp: CIDRS.aks.vpc,
  Description: "CockroachDB HTTP from Azure VNet",
});

// Allow CockroachDB HTTP (8080) from GCP VPC
export const httpFromGcp = new EC2SecurityGroupIngress({
  GroupId: crdbSg.GroupId,
  IpProtocol: "tcp",
  FromPort: 8080,
  ToPort: 8080,
  CidrIp: CIDRS.gke.vpc,
  Description: "CockroachDB HTTP from GCP VPC",
});

// ── Stack Outputs ─────────────────────────────────────────────────

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
