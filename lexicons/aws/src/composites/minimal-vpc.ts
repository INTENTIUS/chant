import { Composite, mergeDefaults } from "@intentius/chant";
import {
  Vpc,
  Subnet,
  InternetGateway,
  VPCGatewayAttachment,
  RouteTable,
  EC2Route,
  SubnetRouteTableAssociation,
  SecurityGroup,
} from "../generated";
import { Select, GetAZs } from "../intrinsics";

export interface MinimalVpcProps {
  cidr?: string;
  subnetCidr?: string;
  defaults?: {
    vpc?: Partial<ConstructorParameters<typeof Vpc>[0]>;
    subnet?: Partial<ConstructorParameters<typeof Subnet>[0]>;
    securityGroup?: Partial<ConstructorParameters<typeof SecurityGroup>[0]>;
  };
}

export const MinimalVpc = Composite<MinimalVpcProps>((props) => {
  const { defaults } = props;
  const cidr = props.cidr ?? "10.0.0.0/24";
  const subnetCidr = props.subnetCidr ?? "10.0.0.0/25";

  const vpc = new Vpc(mergeDefaults({
    CidrBlock: cidr,
    EnableDnsHostnames: true,
    EnableDnsSupport: true,
  }, defaults?.vpc));

  const subnet = new Subnet(mergeDefaults({
    VpcId: vpc.VpcId,
    CidrBlock: subnetCidr,
    AvailabilityZone: Select(0, GetAZs("")),
    MapPublicIpOnLaunch: true,
  }, defaults?.subnet));

  const igw = new InternetGateway({});

  const igwAttachment = new VPCGatewayAttachment({
    VpcId: vpc.VpcId,
    InternetGatewayId: igw.InternetGatewayId,
  });

  const routeTable = new RouteTable({ VpcId: vpc.VpcId });

  const defaultRoute = new EC2Route(
    {
      RouteTableId: routeTable.RouteTableId,
      DestinationCidrBlock: "0.0.0.0/0",
      GatewayId: igw.InternetGatewayId,
    },
    { DependsOn: [igwAttachment] },
  );

  const subnetRta = new SubnetRouteTableAssociation({
    SubnetId: subnet.SubnetId,
    RouteTableId: routeTable.RouteTableId,
  });

  const securityGroup = new SecurityGroup(mergeDefaults({
    GroupDescription: "MinimalVpc default security group",
    VpcId: vpc.VpcId,
  }, defaults?.securityGroup));

  return { vpc, subnet, igw, igwAttachment, routeTable, defaultRoute, subnetRta, securityGroup };
}, "MinimalVpc");
