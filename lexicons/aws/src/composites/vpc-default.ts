import { Composite } from "@intentius/chant";
import {
  Vpc,
  Subnet,
  InternetGateway,
  VPCGatewayAttachment,
  RouteTable,
  EC2Route,
  SubnetRouteTableAssociation,
  EIP,
  NatGateway,
} from "../generated";
import { Select, GetAZs } from "../intrinsics";

export interface VpcDefaultProps {
  cidr?: string;
  publicSubnet1Cidr?: string;
  publicSubnet2Cidr?: string;
  privateSubnet1Cidr?: string;
  privateSubnet2Cidr?: string;
}

export const VpcDefault = Composite<VpcDefaultProps>((props) => {
  const cidr = props.cidr ?? "10.0.0.0/16";
  const publicSubnet1Cidr = props.publicSubnet1Cidr ?? "10.0.0.0/20";
  const publicSubnet2Cidr = props.publicSubnet2Cidr ?? "10.0.16.0/20";
  const privateSubnet1Cidr = props.privateSubnet1Cidr ?? "10.0.128.0/20";
  const privateSubnet2Cidr = props.privateSubnet2Cidr ?? "10.0.144.0/20";

  const az1 = Select(0, GetAZs(""));
  const az2 = Select(1, GetAZs(""));

  const vpc = new Vpc({
    CidrBlock: cidr,
    EnableDnsSupport: true,
    EnableDnsHostnames: true,
  });

  const igw = new InternetGateway({});

  const igwAttachment = new VPCGatewayAttachment({
    VpcId: vpc.VpcId,
    InternetGatewayId: igw.InternetGatewayId,
  });

  // Public subnets
  const publicSubnet1 = new Subnet({
    VpcId: vpc.VpcId,
    CidrBlock: publicSubnet1Cidr,
    AvailabilityZone: az1,
    MapPublicIpOnLaunch: true,
  });

  const publicSubnet2 = new Subnet({
    VpcId: vpc.VpcId,
    CidrBlock: publicSubnet2Cidr,
    AvailabilityZone: az2,
    MapPublicIpOnLaunch: true,
  });

  // Private subnets
  const privateSubnet1 = new Subnet({
    VpcId: vpc.VpcId,
    CidrBlock: privateSubnet1Cidr,
    AvailabilityZone: az1,
  });

  const privateSubnet2 = new Subnet({
    VpcId: vpc.VpcId,
    CidrBlock: privateSubnet2Cidr,
    AvailabilityZone: az2,
  });

  // Public route table
  const publicRouteTable = new RouteTable({
    VpcId: vpc.VpcId,
  });

  const publicRoute = new EC2Route({
    RouteTableId: publicRouteTable.RouteTableId,
    DestinationCidrBlock: "0.0.0.0/0",
    GatewayId: igw.InternetGatewayId,
  });

  const publicRta1 = new SubnetRouteTableAssociation({
    SubnetId: publicSubnet1.SubnetId,
    RouteTableId: publicRouteTable.RouteTableId,
  });

  const publicRta2 = new SubnetRouteTableAssociation({
    SubnetId: publicSubnet2.SubnetId,
    RouteTableId: publicRouteTable.RouteTableId,
  });

  // NAT gateway
  const natEip = new EIP({
    Domain: "vpc",
  });

  const natGateway = new NatGateway({
    AllocationId: natEip.AllocationId,
    SubnetId: publicSubnet1.SubnetId,
  });

  // Private route table
  const privateRouteTable = new RouteTable({
    VpcId: vpc.VpcId,
  });

  const privateRoute = new EC2Route({
    RouteTableId: privateRouteTable.RouteTableId,
    DestinationCidrBlock: "0.0.0.0/0",
    NatGatewayId: natGateway.NatGatewayId,
  });

  const privateRta1 = new SubnetRouteTableAssociation({
    SubnetId: privateSubnet1.SubnetId,
    RouteTableId: privateRouteTable.RouteTableId,
  });

  const privateRta2 = new SubnetRouteTableAssociation({
    SubnetId: privateSubnet2.SubnetId,
    RouteTableId: privateRouteTable.RouteTableId,
  });

  return {
    vpc,
    igw,
    igwAttachment,
    publicSubnet1,
    publicSubnet2,
    privateSubnet1,
    privateSubnet2,
    publicRouteTable,
    publicRoute,
    publicRta1,
    publicRta2,
    privateRouteTable,
    privateRta1,
    privateRta2,
    natEip,
    natGateway,
    privateRoute,
  };
}, "VpcDefault");
