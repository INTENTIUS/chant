import { Composite, mergeDefaults } from "@intentius/chant";
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
  /** Number of availability zones (2 or 3, default: 2). */
  azCount?: 2 | 3;
  publicSubnet1Cidr?: string;
  publicSubnet2Cidr?: string;
  privateSubnet1Cidr?: string;
  privateSubnet2Cidr?: string;
  /** Public subnet 3 CIDR (default: "10.0.32.0/20"). Used when azCount is 3. */
  publicSubnet3Cidr?: string;
  /** Private subnet 3 CIDR (default: "10.0.160.0/20"). Used when azCount is 3. */
  privateSubnet3Cidr?: string;
  defaults?: {
    vpc?: Partial<ConstructorParameters<typeof Vpc>[0]>;
    publicSubnet1?: Partial<ConstructorParameters<typeof Subnet>[0]>;
    publicSubnet2?: Partial<ConstructorParameters<typeof Subnet>[0]>;
    privateSubnet1?: Partial<ConstructorParameters<typeof Subnet>[0]>;
    privateSubnet2?: Partial<ConstructorParameters<typeof Subnet>[0]>;
    publicSubnet3?: Partial<ConstructorParameters<typeof Subnet>[0]>;
    privateSubnet3?: Partial<ConstructorParameters<typeof Subnet>[0]>;
    natGateway?: Partial<ConstructorParameters<typeof NatGateway>[0]>;
  };
}

export const VpcDefault = Composite<VpcDefaultProps>((props) => {
  const { defaults: defs } = props;
  const cidr = props.cidr ?? "10.0.0.0/16";
  const azCount = props.azCount ?? 2;
  const publicSubnet1Cidr = props.publicSubnet1Cidr ?? "10.0.0.0/20";
  const publicSubnet2Cidr = props.publicSubnet2Cidr ?? "10.0.16.0/20";
  const privateSubnet1Cidr = props.privateSubnet1Cidr ?? "10.0.128.0/20";
  const privateSubnet2Cidr = props.privateSubnet2Cidr ?? "10.0.144.0/20";

  const az1 = Select(0, GetAZs(""));
  const az2 = Select(1, GetAZs(""));

  const vpc = new Vpc(mergeDefaults({
    CidrBlock: cidr,
    EnableDnsSupport: true,
    EnableDnsHostnames: true,
  }, defs?.vpc));

  const igw = new InternetGateway({});

  const igwAttachment = new VPCGatewayAttachment({
    VpcId: vpc.VpcId,
    InternetGatewayId: igw.InternetGatewayId,
  });

  // Public subnets
  const publicSubnet1 = new Subnet(mergeDefaults({
    VpcId: vpc.VpcId,
    CidrBlock: publicSubnet1Cidr,
    AvailabilityZone: az1,
    MapPublicIpOnLaunch: true,
  }, defs?.publicSubnet1));

  const publicSubnet2 = new Subnet(mergeDefaults({
    VpcId: vpc.VpcId,
    CidrBlock: publicSubnet2Cidr,
    AvailabilityZone: az2,
    MapPublicIpOnLaunch: true,
  }, defs?.publicSubnet2));

  // Private subnets
  const privateSubnet1 = new Subnet(mergeDefaults({
    VpcId: vpc.VpcId,
    CidrBlock: privateSubnet1Cidr,
    AvailabilityZone: az1,
  }, defs?.privateSubnet1));

  const privateSubnet2 = new Subnet(mergeDefaults({
    VpcId: vpc.VpcId,
    CidrBlock: privateSubnet2Cidr,
    AvailabilityZone: az2,
  }, defs?.privateSubnet2));

  // Public route table
  const publicRouteTable = new RouteTable({
    VpcId: vpc.VpcId,
  });

  const publicRoute = new EC2Route(
    {
      RouteTableId: publicRouteTable.RouteTableId,
      DestinationCidrBlock: "0.0.0.0/0",
      GatewayId: igw.InternetGatewayId,
    },
    { DependsOn: [igwAttachment] },
  );

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

  const natGateway = new NatGateway(mergeDefaults({
    AllocationId: natEip.AllocationId,
    SubnetId: publicSubnet1.SubnetId,
  }, defs?.natGateway));

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

  // ── AZ3 (optional) ──────────────────────────────────────────────

  if (azCount >= 3) {
    const az3 = Select(2, GetAZs(""));
    const publicSubnet3Cidr = props.publicSubnet3Cidr ?? "10.0.32.0/20";
    const privateSubnet3Cidr = props.privateSubnet3Cidr ?? "10.0.160.0/20";

    const publicSubnet3 = new Subnet(mergeDefaults({
      VpcId: vpc.VpcId,
      CidrBlock: publicSubnet3Cidr,
      AvailabilityZone: az3,
      MapPublicIpOnLaunch: true,
    }, defs?.publicSubnet3));

    const privateSubnet3 = new Subnet(mergeDefaults({
      VpcId: vpc.VpcId,
      CidrBlock: privateSubnet3Cidr,
      AvailabilityZone: az3,
    }, defs?.privateSubnet3));

    const publicRta3 = new SubnetRouteTableAssociation({
      SubnetId: publicSubnet3.SubnetId,
      RouteTableId: publicRouteTable.RouteTableId,
    });

    const privateRta3 = new SubnetRouteTableAssociation({
      SubnetId: privateSubnet3.SubnetId,
      RouteTableId: privateRouteTable.RouteTableId,
    });

    return {
      vpc, igw, igwAttachment,
      publicSubnet1, publicSubnet2, publicSubnet3,
      privateSubnet1, privateSubnet2, privateSubnet3,
      publicRouteTable, publicRoute,
      publicRta1, publicRta2, publicRta3,
      privateRouteTable, privateRoute,
      privateRta1, privateRta2, privateRta3,
      natEip, natGateway,
    };
  }

  return {
    vpc, igw, igwAttachment,
    publicSubnet1, publicSubnet2,
    privateSubnet1, privateSubnet2,
    publicRouteTable, publicRoute,
    publicRta1, publicRta2,
    privateRouteTable, privateRoute,
    privateRta1, privateRta2,
    natEip, natGateway,
  };
}, "VpcDefault");
