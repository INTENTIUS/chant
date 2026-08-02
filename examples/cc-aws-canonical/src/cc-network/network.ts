/**
 * The CC lane's canonical example, network half (chant#1198 / behold#100).
 *
 * VPC / subnet / IGW / routes — the real network containment #1208 declares
 * for the cloud half of the round-trip. Its own directory, so chant's
 * directory-based partitioning gives it its own CloudFormation stack and the
 * app half below reaches it through cross-stack Export/ImportValue — which is
 * exactly the shape behold's logical projection recovers containment across
 * (behold `src/logical.ts` `enrichedRefs`).
 *
 * Hand-authored rather than `VpcDefault({})` on purpose: the default composite
 * brings a NAT gateway and an EIP, which cost time on a real account and add
 * nothing this lane exercises.
 */
import {
  Vpc,
  Subnet,
  InternetGateway,
  VPCGatewayAttachment,
  RouteTable,
  EC2Route,
  SubnetRouteTableAssociation,
  output,
} from "@intentius/chant-lexicon-aws";

export const vpc = new Vpc({
  CidrBlock: "10.42.0.0/16",
  EnableDnsSupport: true,
  EnableDnsHostnames: true,
});

export const igw = new InternetGateway({});

export const igwAttachment = new VPCGatewayAttachment({
  VpcId: vpc.VpcId,
  InternetGatewayId: igw.InternetGatewayId,
});

export const publicSubnet = new Subnet({
  VpcId: vpc.VpcId,
  CidrBlock: "10.42.0.0/24",
  MapPublicIpOnLaunch: true,
});

export const privateSubnet = new Subnet({
  VpcId: vpc.VpcId,
  CidrBlock: "10.42.128.0/24",
});

export const publicRouteTable = new RouteTable({ VpcId: vpc.VpcId });

// A default route is terminal by nature: it exists to be applied, and nothing
// references it. COR004 reads that as dead code.
// chant-disable-next-line COR004
export const publicRoute = new EC2Route(
  {
    RouteTableId: publicRouteTable.RouteTableId,
    DestinationCidrBlock: "0.0.0.0/0",
    GatewayId: igw.InternetGatewayId,
  },
  { DependsOn: [igwAttachment] },
);

// Terminal for the same reason as publicRoute above.
// chant-disable-next-line COR004
export const publicRta = new SubnetRouteTableAssociation({
  SubnetId: publicSubnet.SubnetId,
  RouteTableId: publicRouteTable.RouteTableId,
});

export const vpcId = output(vpc.VpcId, "VpcId");
export const privateSubnetId = output(privateSubnet.SubnetId, "PrivateSubnetId");
