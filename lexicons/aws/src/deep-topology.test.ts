/**
 * Deep-read coverage for the EC2 topology types (#1269).
 *
 * The folds' inputs — VPC, subnet, route table, internet gateway, and the
 * joins between them — were exactly the types the deep reader could not read,
 * so a snapshot-backed query could answer identity questions and not a single
 * fold question. These tests drive each added type through the real reader
 * against faked describes, and close with the fold-level proof: a question
 * that was previously unanswerable (is this VPC the provider's default?)
 * answered from the deep read alone.
 *
 * Same seams as deep-observe.test.ts: Cloud Control and CloudFormation are
 * faked at the injected `http` transport, the EC2 describes at the runtime's
 * `spawn`.
 */
import { describe, test, expect, vi, beforeEach } from "vitest";

const spawnMock = vi.fn();
vi.mock("@intentius/chant/runtime-adapter", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@intentius/chant/runtime-adapter")>();
  return { ...actual, getRuntime: () => ({ ...actual.getRuntime(), spawn: spawnMock }) };
});

const { observeResourcesDeepAws, DEEP_READABLE_TYPES, awsDeepNormalizationHooks } = await import("./deep-observe");
const { vpcToModel, subnetToModel, routeTableToModel, internetGatewayToModel } = await import("./deep-topology");
const { stampProviderDefaults } = await import("./defaults");
const { normalizeDeepObservation } = await import("@intentius/chant/deep-observation");
const { diffDeepObservation } = await import("@intentius/chant/lifecycle/deep-observe");

const ok = (text: string) => ({ status: 200, text });

/** A Cloud Control `GetResource` body — the model arrives as a JSON string. */
const cloudControl = (identifier: string, properties: Record<string, unknown>) =>
  ok(JSON.stringify({ ResourceDescription: { Identifier: identifier, Properties: JSON.stringify(properties) } }));

const stackResources = (rows: Array<[string, string, string]>) =>
  ok(
    `<DescribeStackResourcesResponse><DescribeStackResourcesResult><StackResources>${rows
      .map(
        ([logicalId, type, physicalId]) =>
          `<member><LogicalResourceId>${logicalId}</LogicalResourceId><ResourceType>${type}</ResourceType>` +
          `<PhysicalResourceId>${physicalId}</PhysicalResourceId><ResourceStatus>CREATE_COMPLETE</ResourceStatus>` +
          `<Timestamp>2026-01-01T00:00:00Z</Timestamp></member>`,
      )
      .join("")}</StackResources></DescribeStackResourcesResult></DescribeStackResourcesResponse>`,
  );

type FakeResponse = { status: number; text: string };

/** Route on the Cloud Control identifier; `undefined` is the CloudFormation call. */
function httpFake(route: (identifier: string | undefined) => FakeResponse) {
  return async (_url: string, init: { headers: Record<string, string>; body: string }) => {
    const target = init.headers["x-amz-target"];
    const identifier = target ? (JSON.parse(init.body) as { Identifier?: string }).Identifier : undefined;
    return route(identifier);
  };
}

/** Route each EC2 bulk describe on its subcommand (`argv[2]`). */
function ec2Describes(byCommand: Record<string, Record<string, unknown[]>>) {
  spawnMock.mockImplementation((argv: string[]) => {
    const body = byCommand[argv[2]];
    if (!body) return Promise.resolve({ stdout: "", stderr: `no fake for ${argv[2]}`, exitCode: 255 });
    return Promise.resolve({ stdout: JSON.stringify(body), stderr: "", exitCode: 0 });
  });
}

const entities = (
  record: Record<string, { entityType: string; props: Record<string, unknown> }>,
): Map<string, { entityType: string; props: Record<string, unknown> }> => new Map(Object.entries(record));

const vpcRow = {
  VpcId: "vpc-01",
  State: "available",
  OwnerId: "111122223333",
  CidrBlock: "10.0.0.0/16",
  DhcpOptionsId: "dopt-01",
  InstanceTenancy: "default",
  IsDefault: false,
  CidrBlockAssociationSet: [{ AssociationId: "vpc-cidr-assoc-01", CidrBlock: "10.0.0.0/16" }],
  Tags: [{ Key: "env", Value: "prod" }],
};

// Braces matter: `mockReset()` returns the mock, and a function returned from
// a vitest hook is called as a cleanup hook — the mock invoked with no argv.
beforeEach(() => {
  spawnMock.mockReset();
});

describe("the topology translations", () => {
  test("a VPC row maps onto the resource model, keeping the provider's default marker", () => {
    expect(vpcToModel(vpcRow)).toEqual({
      VpcId: "vpc-01",
      CidrBlock: "10.0.0.0/16",
      InstanceTenancy: "default",
      IsDefault: false,
      Tags: [{ Key: "env", Value: "prod" }],
    });
  });

  test("a subnet row keeps both fold inputs: the VPC hop and MapPublicIpOnLaunch", () => {
    expect(
      subnetToModel({
        SubnetId: "subnet-01",
        VpcId: "vpc-01",
        State: "available",
        OwnerId: "111122223333",
        CidrBlock: "10.0.1.0/24",
        AvailabilityZone: "us-east-1a",
        AvailabilityZoneId: "use1-az1",
        AvailableIpAddressCount: 250,
        MapPublicIpOnLaunch: true,
        AssignIpv6AddressOnCreation: false,
        DefaultForAz: false,
        Ipv6Native: false,
        PrivateDnsNameOptionsOnLaunch: { HostnameType: "ip-name" },
      }),
    ).toEqual({
      SubnetId: "subnet-01",
      VpcId: "vpc-01",
      CidrBlock: "10.0.1.0/24",
      AvailabilityZone: "us-east-1a",
      AvailabilityZoneId: "use1-az1",
      MapPublicIpOnLaunch: true,
      AssignIpv6AddressOnCreation: false,
      Ipv6Native: false,
      DefaultForAz: false,
    });
  });

  test("a route table's routes and associations are its own declared resources, not carried twice", () => {
    expect(
      routeTableToModel({
        RouteTableId: "rtb-01",
        VpcId: "vpc-01",
        Routes: [{ DestinationCidrBlock: "0.0.0.0/0", GatewayId: "igw-01" }],
        Associations: [{ Main: false, SubnetId: "subnet-01" }],
        PropagatingVgws: [],
      }),
    ).toEqual({ RouteTableId: "rtb-01", VpcId: "vpc-01" });
  });

  test("an internet gateway is tags and nothing else; an empty tag set is absence, not a value", () => {
    expect(internetGatewayToModel({ InternetGatewayId: "igw-01", Attachments: [], Tags: [] })).toEqual({
      InternetGatewayId: "igw-01",
    });
  });
});

describe("deep-reading an EC2 topology stack", () => {
  const topologyStack = stackResources([
    ["Net", "AWS::EC2::VPC", "vpc-01"],
    ["PublicSubnet", "AWS::EC2::Subnet", "subnet-01"],
    ["PublicRoutes", "AWS::EC2::RouteTable", "rtb-01"],
    ["Igw", "AWS::EC2::InternetGateway", "igw-01"],
  ]);

  test("every topology type from #1269 is readable", () => {
    for (const type of [
      "AWS::EC2::VPC",
      "AWS::EC2::Subnet",
      "AWS::EC2::RouteTable",
      "AWS::EC2::Route",
      "AWS::EC2::SubnetRouteTableAssociation",
      "AWS::EC2::InternetGateway",
      "AWS::EC2::VPCGatewayAttachment",
      "AWS::EC2::Instance",
      "AWS::EC2::LaunchTemplate",
    ]) {
      expect(DEEP_READABLE_TYPES.has(type)).toBe(true);
    }
  });

  test("one bulk describe per type, and every tree is recorded", async () => {
    ec2Describes({
      "describe-vpcs": { Vpcs: [vpcRow] },
      "describe-subnets": {
        Subnets: [{ SubnetId: "subnet-01", VpcId: "vpc-01", CidrBlock: "10.0.1.0/24", MapPublicIpOnLaunch: true }],
      },
      "describe-route-tables": { RouteTables: [{ RouteTableId: "rtb-01", VpcId: "vpc-01", Routes: [] }] },
      "describe-internet-gateways": { InternetGateways: [{ InternetGatewayId: "igw-01", Attachments: [] }] },
    });
    const result = normalizeDeepObservation(
      await observeResourcesDeepAws({
        environment: "prod",
        entityNames: ["Net", "PublicSubnet", "PublicRoutes", "Igw"],
        http: httpFake(() => topologyStack),
      }),
    );

    expect(Object.keys(result.resources).sort()).toEqual(["Igw", "Net", "PublicRoutes", "PublicSubnet"]);
    expect(result.unobserved).toEqual({});

    // The containment hop and the public-IP fact the folds read.
    expect(result.resources.PublicSubnet.properties).toMatchObject({
      VpcId: "vpc-01",
      MapPublicIpOnLaunch: true,
    });
    // Server-minted ids are pruned by the schema's own readOnlyProperties.
    expect(result.resources.Net.properties.VpcId).toBeUndefined();
    expect(result.resources.PublicSubnet.properties.SubnetId).toBeUndefined();
    // The provider's default marker survives into the snapshot for the fold.
    expect(result.resources.Net.properties.IsDefault).toBe(false);

    // Four types, four describes — never one call per resource.
    expect(spawnMock).toHaveBeenCalledTimes(4);
    const commands = spawnMock.mock.calls.map((c) => (c[0] as string[])[2]).sort();
    expect(commands).toEqual([
      "describe-internet-gateways",
      "describe-route-tables",
      "describe-subnets",
      "describe-vpcs",
    ]);
  });

  test("the routing-chain joins read through Cloud Control by their physical id", async () => {
    const http = httpFake((identifier) => {
      if (identifier === undefined) {
        return stackResources([
          ["DefaultRoute", "AWS::EC2::Route", "rtb-01|0.0.0.0/0"],
          ["SubnetRoutes", "AWS::EC2::SubnetRouteTableAssociation", "rtbassoc-01"],
          ["IgwAttachment", "AWS::EC2::VPCGatewayAttachment", "IGW|vpc-01"],
        ]);
      }
      if (identifier === "rtb-01|0.0.0.0/0") {
        return cloudControl(identifier, {
          RouteTableId: "rtb-01",
          DestinationCidrBlock: "0.0.0.0/0",
          GatewayId: "igw-01",
        });
      }
      if (identifier === "rtbassoc-01") {
        return cloudControl(identifier, { Id: "rtbassoc-01", RouteTableId: "rtb-01", SubnetId: "subnet-01" });
      }
      return cloudControl(identifier, { InternetGatewayId: "igw-01", VpcId: "vpc-01" });
    });
    const result = normalizeDeepObservation(
      await observeResourcesDeepAws({
        environment: "prod",
        entityNames: ["DefaultRoute", "SubnetRoutes", "IgwAttachment"],
        http,
      }),
    );

    // The `0.0.0.0/0` -> igw edge `internetFacing` walks.
    expect(result.resources.DefaultRoute.properties).toEqual({
      RouteTableId: "rtb-01",
      DestinationCidrBlock: "0.0.0.0/0",
      GatewayId: "igw-01",
    });
    // Subnet -> route table, with the association's own minted id pruned.
    expect(result.resources.SubnetRoutes.properties).toEqual({
      RouteTableId: "rtb-01",
      SubnetId: "subnet-01",
    });
    // Igw -> VPC.
    expect(result.resources.IgwAttachment.properties).toEqual({
      InternetGatewayId: "igw-01",
      VpcId: "vpc-01",
    });
    expect(spawnMock).not.toHaveBeenCalled();
  });

  test("a type without a source is still a stated hole, not a silent one", async () => {
    const result = normalizeDeepObservation(
      await observeResourcesDeepAws({
        environment: "prod",
        entityNames: ["Ip"],
        http: httpFake(() => stackResources([["Ip", "AWS::EC2::EIP", "203.0.113.7"]])),
      }),
    );
    expect(result.resources).toEqual({});
    expect(result.unobserved.Ip.reason).toBe("unsupported-kind");
  });
});

describe("the fold answers (#1269)", () => {
  const vpcStack = stackResources([
    ["Net", "AWS::EC2::VPC", "vpc-01"],
    ["Legacy", "AWS::EC2::VPC", "vpc-02"],
  ]);

  test("IsDefault on a VPC — previously unanswerable — answers from the deep read", async () => {
    ec2Describes({
      "describe-vpcs": {
        Vpcs: [vpcRow, { ...vpcRow, VpcId: "vpc-02", CidrBlock: "172.31.0.0/16", IsDefault: true, Tags: [] }],
      },
    });
    const observed = normalizeDeepObservation(
      await observeResourcesDeepAws({
        environment: "prod",
        entityNames: ["Net", "Legacy"],
        http: httpFake(() => vpcStack),
      }),
    );

    // The classification fold reads the provider's own marker off the
    // recorded properties — nothing to re-fetch, no heuristics.
    const stamped = stampProviderDefaults(
      Object.fromEntries(
        Object.entries(observed.resources).map(([name, r]) => [
          name,
          { type: r.type, status: "CREATE_COMPLETE", attributes: r.properties },
        ]),
      ),
    );
    expect(stamped.Legacy.attributes?.providerDefault).toBe(true);
    expect(stamped.Net.attributes?.providerDefault).toBeUndefined();
  });

  test("the marker feeds the fold without surfacing as drift on a declared VPC", async () => {
    ec2Describes({ "describe-vpcs": { Vpcs: [vpcRow] } });
    const observed = normalizeDeepObservation(
      await observeResourcesDeepAws({
        environment: "prod",
        entityNames: ["Net"],
        http: httpFake(() => stackResources([["Net", "AWS::EC2::VPC", "vpc-01"]])),
      }),
    );
    const declared = entities({
      Net: {
        entityType: "AWS::EC2::VPC",
        props: { CidrBlock: "10.0.0.0/16", Tags: [{ Key: "env", Value: "prod" }] },
      },
    });

    // In the snapshot for a query to read…
    expect(observed.resources.Net.properties.IsDefault).toBe(false);
    // …and subtracted in the diff, where source never declared it.
    const diff = diffDeepObservation(declared, observed, awsDeepNormalizationHooks);
    expect(diff.drifted).toEqual([]);
    expect(diff.unchanged).toEqual(["Net"]);
  });

  test("declared DNS attributes are a source blind spot, not absence drift; a visible change still reports", async () => {
    ec2Describes({ "describe-vpcs": { Vpcs: [{ ...vpcRow, CidrBlock: "10.9.0.0/16", Tags: [] }] } });
    const observed = normalizeDeepObservation(
      await observeResourcesDeepAws({
        environment: "prod",
        entityNames: ["Net"],
        http: httpFake(() => stackResources([["Net", "AWS::EC2::VPC", "vpc-01"]])),
      }),
    );
    const declared = entities({
      Net: {
        entityType: "AWS::EC2::VPC",
        props: { CidrBlock: "10.0.0.0/16", EnableDnsSupport: true, EnableDnsHostnames: true },
      },
    });

    const diff = diffDeepObservation(declared, observed, awsDeepNormalizationHooks);
    expect(diff.drifted).toEqual([
      {
        name: "Net",
        type: "AWS::EC2::VPC",
        changes: [
          { path: "CidrBlock", kind: "changed", declared: "10.0.0.0/16", live: "10.9.0.0/16" },
        ],
      },
    ]);
  });

  test("an out-of-band MapPublicIpOnLaunch flip reports; the service default does not", async () => {
    const subnetRow = (mapPublic: boolean) => ({
      Subnets: [{ SubnetId: "subnet-01", VpcId: "vpc-01", CidrBlock: "10.0.1.0/24", MapPublicIpOnLaunch: mapPublic }],
    });
    const declared = entities({
      PublicSubnet: { entityType: "AWS::EC2::Subnet", props: { VpcId: "vpc-01", CidrBlock: "10.0.1.0/24" } },
    });
    const observe = async () =>
      normalizeDeepObservation(
        await observeResourcesDeepAws({
          environment: "prod",
          entityNames: ["PublicSubnet"],
          http: httpFake(() => stackResources([["PublicSubnet", "AWS::EC2::Subnet", "subnet-01"]])),
        }),
      );

    ec2Describes({ "describe-subnets": subnetRow(false) });
    expect(diffDeepObservation(declared, await observe(), awsDeepNormalizationHooks).drifted).toEqual([]);

    ec2Describes({ "describe-subnets": subnetRow(true) });
    const diff = diffDeepObservation(declared, await observe(), awsDeepNormalizationHooks);
    expect(diff.drifted).toEqual([
      {
        name: "PublicSubnet",
        type: "AWS::EC2::Subnet",
        changes: [{ path: "MapPublicIpOnLaunch", kind: "undeclared", live: true }],
      },
    ]);
  });
});
