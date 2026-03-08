// VPC with 3 availability zones — explicit security groups for EKS.

import {
  VpcDefault,
  SecurityGroup,
  SecurityGroup_Ingress,
} from "@intentius/chant-lexicon-aws";

// ── VPC (3-AZ) ──────────────────────────────────────────────────────

export const vpcBase = VpcDefault({
  cidr: "10.0.0.0/16",
  azCount: 3,
  publicSubnet1Cidr: "10.0.0.0/20",
  publicSubnet2Cidr: "10.0.16.0/20",
  publicSubnet3Cidr: "10.0.32.0/20",
  privateSubnet1Cidr: "10.0.128.0/20",
  privateSubnet2Cidr: "10.0.144.0/20",
  privateSubnet3Cidr: "10.0.160.0/20",
});

// ── Security Groups ─────────────────────────────────────────────────

export const controlPlaneSg = new SecurityGroup({
  GroupDescription: "EKS control plane security group",
  VpcId: vpcBase.vpc.VpcId,
});

export const nodesSg = new SecurityGroup({
  GroupDescription: "EKS node group security group",
  VpcId: vpcBase.vpc.VpcId,
});

// Control plane → nodes (kubelet, extension API)
new SecurityGroup_Ingress({
  GroupId: nodesSg.GroupId,
  SourceSecurityGroupId: controlPlaneSg.GroupId,
  IpProtocol: "tcp",
  FromPort: 1025,
  ToPort: 65535,
});

// Nodes → control plane (API server)
new SecurityGroup_Ingress({
  GroupId: controlPlaneSg.GroupId,
  SourceSecurityGroupId: nodesSg.GroupId,
  IpProtocol: "tcp",
  FromPort: 443,
  ToPort: 443,
});

// Node-to-node communication
new SecurityGroup_Ingress({
  GroupId: nodesSg.GroupId,
  SourceSecurityGroupId: nodesSg.GroupId,
  IpProtocol: "-1",
  FromPort: -1,
  ToPort: -1,
});

export const network = {
  vpc: vpcBase.vpc,
  publicSubnet1: vpcBase.publicSubnet1,
  publicSubnet2: vpcBase.publicSubnet2,
  publicSubnet3: vpcBase.publicSubnet3,
  privateSubnet1: vpcBase.privateSubnet1,
  privateSubnet2: vpcBase.privateSubnet2,
  privateSubnet3: vpcBase.privateSubnet3,
  natGateway: vpcBase.natGateway,
  controlPlaneSg,
  nodesSg,
};
