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
  cidrBlock: "10.0.0.0/16",
  enableDnsSupport: true,
  enableDnsHostnames: true,
  tags: [{ key: "Name", value: Sub`${AWS.StackName}-vpc` }],
});

export const subnet = new Subnet({
  vpcId: vpc.vpcId,
  cidrBlock: "10.0.1.0/24",
  mapPublicIpOnLaunch: true,
  tags: [{ key: "Name", value: Sub`${AWS.StackName}-public` }],
});

export const igw = new InternetGateway({
  tags: [{ key: "Name", value: Sub`${AWS.StackName}-igw` }],
});

export const igwAttachment = new VPCGatewayAttachment({
  vpcId: vpc.vpcId,
  internetGatewayId: igw.internetGatewayId,
});

export const routeTable = new RouteTable({
  vpcId: vpc.vpcId,
  tags: [{ key: "Name", value: Sub`${AWS.StackName}-public-rt` }],
});

export const defaultRoute = new EC2Route({
  routeTableId: routeTable.routeTableId,
  destinationCidrBlock: "0.0.0.0/0",
  gatewayId: igw.internetGatewayId,
});

export const subnetRouteTableAssoc = new SubnetRouteTableAssociation({
  subnetId: subnet.subnetId,
  routeTableId: routeTable.routeTableId,
});
