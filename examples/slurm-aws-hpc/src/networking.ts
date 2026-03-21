import {
  Vpc,
  Subnet,
  InternetGateway,
  VPCGatewayAttachment,
  RouteTable,
  NatGateway,
  PlacementGroup,
} from "@intentius/chant-lexicon-aws";
import { Ref, Sub, GetAtt } from "@intentius/chant-lexicon-aws";
import { config } from "./config";

// ── VPC ───────────────────────────────────────────────────────────

export const vpc = new Vpc({
  CidrBlock: config.vpcCidr,
  EnableDnsHostnames: true,
  EnableDnsSupport: true,
  Tags: [{ Key: "Name", Value: Sub(`${config.clusterName}-vpc`) }],
});

// ── Subnets (private — HPC nodes don't need public IPs) ──────────

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

// ── Internet Gateway (for NAT + head node egress) ──────────────────

export const igw = new InternetGateway({
  Tags: [{ Key: "Name", Value: `${config.clusterName}-igw` }],
});

export const igwAttachment = new VPCGatewayAttachment({
  VpcId: vpc.VpcId,
  InternetGatewayId: igw.InternetGatewayId,
});

// ── Route tables ───────────────────────────────────────────────────

export const privateRouteTable = new RouteTable({
  VpcId: vpc.VpcId,
  Tags: [{ Key: "Name", Value: `${config.clusterName}-private-rt` }],
});

// ── EFA Cluster Placement Group ────────────────────────────────────
// Required for full-bandwidth EFA networking between GPU nodes.
// p4d.24xlarge achieves ~400 Gbps aggregate with EFA in a placement group.

export const efaPlacementGroup = new PlacementGroup({
  Strategy: "cluster",
  Tags: [{ Key: "Name", Value: `${config.clusterName}-efa-pg` }],
});
