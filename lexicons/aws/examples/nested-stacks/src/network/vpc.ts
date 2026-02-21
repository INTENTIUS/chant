/**
 * Network resources — VPC, subnet, internet gateway, and routing
 */

import {
  Vpc,
  Subnet,
  InternetGateway,
  VPCGatewayAttachment,
  RouteTable,
  EC2Route,
  SubnetRouteTableAssociation,
  Sub,
  AWS,
} from "@intentius/chant-lexicon-aws";

export const vpc = new Vpc({
  CidrBlock: "10.0.0.0/16",
  EnableDnsSupport: true,
  EnableDnsHostnames: true,
  Tags: [{ Key: "Name", Value: Sub`${AWS.StackName}-vpc` }],
});

export const subnet = new Subnet({
  VpcId: vpc.VpcId,
  CidrBlock: "10.0.1.0/24",
  MapPublicIpOnLaunch: true,
  Tags: [{ Key: "Name", Value: Sub`${AWS.StackName}-public` }],
});

export const igw = new InternetGateway({
  Tags: [{ Key: "Name", Value: Sub`${AWS.StackName}-igw` }],
});

export const igwAttachment = new VPCGatewayAttachment({
  VpcId: vpc.VpcId,
  InternetGatewayId: igw.InternetGatewayId,
});

export const routeTable = new RouteTable({
  VpcId: vpc.VpcId,
  Tags: [{ Key: "Name", Value: Sub`${AWS.StackName}-public-rt` }],
});

export const defaultRoute = new EC2Route({
  RouteTableId: routeTable.RouteTableId,
  DestinationCidrBlock: "0.0.0.0/0",
  GatewayId: igw.InternetGatewayId,
});

export const subnetRouteTableAssoc = new SubnetRouteTableAssociation({
  SubnetId: subnet.SubnetId,
  RouteTableId: routeTable.RouteTableId,
});
