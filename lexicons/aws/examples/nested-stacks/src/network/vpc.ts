/**
 * Network resources — VPC, subnet, internet gateway, and routing
 */

import * as _ from "./_";

export const vpc = new _.Vpc({
  cidrBlock: "10.0.0.0/16",
  enableDnsSupport: true,
  enableDnsHostnames: true,
  tags: [{ key: "Name", value: _.Sub`${_.AWS.StackName}-vpc` }],
});

export const subnet = new _.Subnet({
  vpcId: vpc.vpcId,
  cidrBlock: "10.0.1.0/24",
  mapPublicIpOnLaunch: true,
  tags: [{ key: "Name", value: _.Sub`${_.AWS.StackName}-public` }],
});

export const igw = new _.InternetGateway({
  tags: [{ key: "Name", value: _.Sub`${_.AWS.StackName}-igw` }],
});

export const igwAttachment = new _.VPCGatewayAttachment({
  vpcId: vpc.vpcId,
  internetGatewayId: igw.internetGatewayId,
});

export const routeTable = new _.RouteTable({
  vpcId: vpc.vpcId,
  tags: [{ key: "Name", value: _.Sub`${_.AWS.StackName}-public-rt` }],
});

export const defaultRoute = new _.EC2Route({
  routeTableId: routeTable.routeTableId,
  destinationCidrBlock: "0.0.0.0/0",
  gatewayId: igw.internetGatewayId,
});

export const subnetRouteTableAssoc = new _.SubnetRouteTableAssociation({
  subnetId: subnet.subnetId,
  routeTableId: routeTable.routeTableId,
});
