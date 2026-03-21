import {
  Vpc,
  Subnet,
  InternetGateway,
  VPCGatewayAttachment,
  RouteTable,
  EC2Route,
  SubnetRouteTableAssociation,
  NatGateway,
  EIP,
  PlacementGroup,
} from "@intentius/chant-lexicon-aws";
import { Sub } from "@intentius/chant-lexicon-aws";
import { config } from "./config";

// ── VPC ───────────────────────────────────────────────────────────

export const vpc = new Vpc({
  CidrBlock: config.vpcCidr,
  EnableDnsHostnames: true,
  EnableDnsSupport: true,
  Tags: [{ Key: "Name", Value: Sub(`${config.clusterName}-vpc`) }],
});

// ── Subnets ───────────────────────────────────────────────────────
// One public subnet (for NAT Gateway) + three private subnets (HPC nodes)

export const publicSubnet = new Subnet({
  VpcId: vpc.VpcId,
  CidrBlock: "10.0.0.0/24",
  AvailabilityZone: Sub(`${config.region}a`),
  MapPublicIpOnLaunch: true,
  Tags: [{ Key: "Name", Value: `${config.clusterName}-public-1` }],
});

export const privateSubnet1 = new Subnet({
  VpcId: vpc.VpcId,
  CidrBlock: config.privateSubnet1Cidr,
  AvailabilityZone: Sub(`${config.region}a`),
  Tags: [{ Key: "Name", Value: `${config.clusterName}-private-1` }],
});

export const privateSubnet2 = new Subnet({
  VpcId: vpc.VpcId,
  CidrBlock: config.privateSubnet2Cidr,
  AvailabilityZone: Sub(`${config.region}b`),
  Tags: [{ Key: "Name", Value: `${config.clusterName}-private-2` }],
});

export const privateSubnet3 = new Subnet({
  VpcId: vpc.VpcId,
  CidrBlock: config.privateSubnet3Cidr,
  AvailabilityZone: Sub(`${config.region}c`),
  Tags: [{ Key: "Name", Value: `${config.clusterName}-private-3` }],
});

// ── Internet Gateway ───────────────────────────────────────────────

export const igw = new InternetGateway({
  Tags: [{ Key: "Name", Value: `${config.clusterName}-igw` }],
});

export const igwAttachment = new VPCGatewayAttachment({
  VpcId: vpc.VpcId,
  InternetGatewayId: igw.InternetGatewayId,
});

// ── NAT Gateway (outbound internet for private subnets) ───────────

export const natEip = new EIP({
  Domain: "vpc",
  Tags: [{ Key: "Name", Value: `${config.clusterName}-nat-eip` }],
});

export const natGateway = new NatGateway({
  SubnetId: publicSubnet.SubnetId,
  AllocationId: natEip.AllocationId,
  Tags: [{ Key: "Name", Value: `${config.clusterName}-nat` }],
});

// ── Route tables ───────────────────────────────────────────────────

export const publicRouteTable = new RouteTable({
  VpcId: vpc.VpcId,
  Tags: [{ Key: "Name", Value: `${config.clusterName}-public-rt` }],
});

export const publicRoute = new EC2Route({
  RouteTableId: publicRouteTable.RouteTableId,
  DestinationCidrBlock: "0.0.0.0/0",
  GatewayId: igw.InternetGatewayId,
});

export const publicSubnetRta = new SubnetRouteTableAssociation({
  SubnetId: publicSubnet.SubnetId,
  RouteTableId: publicRouteTable.RouteTableId,
});

export const privateRouteTable = new RouteTable({
  VpcId: vpc.VpcId,
  Tags: [{ Key: "Name", Value: `${config.clusterName}-private-rt` }],
});

// Default route for private subnets → NAT Gateway
export const privateRoute = new EC2Route({
  RouteTableId: privateRouteTable.RouteTableId,
  DestinationCidrBlock: "0.0.0.0/0",
  NatGatewayId: natGateway.NatGatewayId,
});

export const privateSubnet1Rta = new SubnetRouteTableAssociation({
  SubnetId: privateSubnet1.SubnetId,
  RouteTableId: privateRouteTable.RouteTableId,
});

export const privateSubnet2Rta = new SubnetRouteTableAssociation({
  SubnetId: privateSubnet2.SubnetId,
  RouteTableId: privateRouteTable.RouteTableId,
});

export const privateSubnet3Rta = new SubnetRouteTableAssociation({
  SubnetId: privateSubnet3.SubnetId,
  RouteTableId: privateRouteTable.RouteTableId,
});

// ── EFA Cluster Placement Group ────────────────────────────────────
// Required for full-bandwidth EFA networking between GPU nodes.
// p4d.24xlarge achieves ~400 Gbps aggregate with EFA in a placement group.

export const efaPlacementGroup = new PlacementGroup({
  Strategy: "cluster",
  Tags: [{ Key: "Name", Value: `${config.clusterName}-efa-pg` }],
});
