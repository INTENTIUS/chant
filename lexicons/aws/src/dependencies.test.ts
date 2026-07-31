import { describe, it, expect, vi, beforeEach } from "vitest";

// Every AWS interaction is a mocked `spawn` — the reader's only edge is the
// runtime adapter, and nothing here constructs a client or reaches a network.
const spawnMock = vi.fn();
vi.mock("@intentius/chant/runtime-adapter", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@intentius/chant/runtime-adapter")>();
  return { ...actual, getRuntime: () => ({ ...actual.getRuntime(), spawn: spawnMock }) };
});

const { toIngressRules, observeAwsDependencies } = await import("./dependencies");

const ok = (body: unknown) => ({ stdout: JSON.stringify(body), stderr: "", exitCode: 0 });

/** Route the mock by the AWS subcommand, so ordering is not load-bearing. */
function respond(handlers: Record<string, unknown>) {
  spawnMock.mockImplementation((...args: unknown[]) => {
    const argv = (args[0] ?? []) as string[];
    const at = argv.indexOf("aws");
    const key = argv.slice(at + 1, at + 3).join(" ");
    const body = handlers[key];
    return Promise.resolve(body ? ok(body) : { stdout: "", stderr: "not mocked: " + key, exitCode: 255 });
  });
}

// #1276 — the two AWS surfaces disagree about the same concept. A template's
// SecurityGroupIngress carries CidrIp flat; describe-security-groups nests
// sources under IpRanges[]/Ipv6Ranges[]/UserIdGroupPairs[], and one permission
// can hold several. Handing the describe shape to the fold unchanged renders
// every source as `?`, which matches no CIDR query and narrows the answer.
describe("toIngressRules (#1276)", () => {
  it("flattens an IPv4 range into the flat rule the fold reads", () => {
    expect(
      toIngressRules([{ IpProtocol: "tcp", FromPort: 22, ToPort: 22, IpRanges: [{ CidrIp: "0.0.0.0/0" }] }]),
    ).toEqual([{ IpProtocol: "tcp", FromPort: 22, ToPort: 22, CidrIp: "0.0.0.0/0" }]);
  });

  it("emits one rule per source, because that is what the flat shape means", () => {
    const rules = toIngressRules([
      {
        IpProtocol: "tcp",
        FromPort: 443,
        ToPort: 443,
        IpRanges: [{ CidrIp: "10.0.0.0/8" }, { CidrIp: "192.168.0.0/16" }],
        UserIdGroupPairs: [{ GroupId: "sg-peer" }],
      },
    ]);
    expect(rules).toHaveLength(3);
    expect(rules.map((r) => r.CidrIp ?? r.SourceSecurityGroupId)).toEqual([
      "10.0.0.0/8",
      "192.168.0.0/16",
      "sg-peer",
    ]);
  });

  it("carries IPv6 sources through their own key", () => {
    expect(toIngressRules([{ IpProtocol: "tcp", Ipv6Ranges: [{ CidrIpv6: "::/0" }] }])).toEqual([
      { IpProtocol: "tcp", CidrIpv6: "::/0" },
    ]);
  });

  it("an all-protocols rule keeps the -1 the fold expects, and omits absent ports", () => {
    // FromPort absent is "all ports" to normalizeIngress; emitting FromPort:
    // undefined would render as a port range rather than `all`.
    expect(toIngressRules([{ IpRanges: [{ CidrIp: "0.0.0.0/0" }] }])).toEqual([
      { IpProtocol: "-1", CidrIp: "0.0.0.0/0" },
    ]);
  });

  it("a permission with no source contributes nothing", () => {
    expect(toIngressRules([{ IpProtocol: "tcp", FromPort: 22, ToPort: 22 }])).toEqual([]);
  });
});


// #1276 — the case the benchmark estate deliberately cannot exercise, because
// it declares every security group. The fix matters precisely where an instance
// is guarded by a group nobody declared, so it is proven here rather than by
// changing a scenario a published comparison depends on.
describe("undeclared security groups (#1276)", () => {
  beforeEach(() => spawnMock.mockReset());

  const observedInstanceOnly = {
    webServer: { type: "AWS::EC2::Instance", status: "CREATE_COMPLETE", physicalId: "i-1" },
  };

  it("reports a security group the estate never declared, with its rules", async () => {
    respond({
      "ec2 describe-instances": {
        Reservations: [
          {
            Instances: [
              { InstanceId: "i-1", SubnetId: "subnet-1", VpcId: "vpc-1", SecurityGroups: [{ GroupId: "sg-shared" }] },
            ],
          },
        ],
      },
      "ec2 describe-route-tables": { RouteTables: [] },
      "ec2 describe-security-groups": {
        SecurityGroups: [
          {
            GroupId: "sg-shared",
            VpcId: "vpc-1",
            IpPermissions: [
              { IpProtocol: "tcp", FromPort: 22, ToPort: 22, IpRanges: [{ CidrIp: "0.0.0.0/0" }] },
            ],
          },
        ],
      },
    });

    const { resources, edges } = await observeAwsDependencies({ observed: observedInstanceOnly });

    // The group is a node now, so the fold can read its rules at all.
    expect(resources["sg-shared"]).toMatchObject({
      type: "AWS::EC2::SecurityGroup",
      physicalId: "sg-shared",
      referencedBy: ["webServer"],
    });
    // In the flat shape the fold reads — not the nested describe shape, which
    // would render every source as `?` and match no CIDR query.
    expect(resources["sg-shared"].attributes?.SecurityGroupIngress).toEqual([
      { IpProtocol: "tcp", FromPort: 22, ToPort: 22, CidrIp: "0.0.0.0/0" },
    ]);
    expect(edges).toContainEqual({ from: "webServer", to: "sg-shared", kind: "ref", viaAttr: "SecurityGroupIds" });
  });

  it("does not report a group the estate already declares", async () => {
    respond({
      "ec2 describe-instances": {
        Reservations: [
          { Instances: [{ InstanceId: "i-1", SubnetId: "subnet-1", SecurityGroups: [{ GroupId: "sg-mine" }] }] },
        ],
      },
      "ec2 describe-route-tables": { RouteTables: [] },
    });

    const { resources } = await observeAwsDependencies({
      observed: {
        ...observedInstanceOnly,
        webSg: { type: "AWS::EC2::SecurityGroup", status: "CREATE_COMPLETE", physicalId: "sg-mine" },
      },
    });

    // Declared resources are the managed observation's job. Reporting one here
    // too would double it as both managed and dependency.
    expect(resources["sg-mine"]).toBeUndefined();
  });

  it("follows a launch template to the groups it attaches", async () => {
    respond({
      "ec2 describe-instances": {
        Reservations: [
          {
            Instances: [
              {
                InstanceId: "i-1",
                SubnetId: "subnet-1",
                SecurityGroups: [],
                LaunchTemplate: { LaunchTemplateId: "lt-1" },
              },
            ],
          },
        ],
      },
      "ec2 describe-route-tables": { RouteTables: [] },
      "ec2 describe-launch-template-versions": {
        LaunchTemplateVersions: [{ LaunchTemplateData: { SecurityGroupIds: ["sg-via-lt"] } }],
      },
      "ec2 describe-security-groups": {
        SecurityGroups: [
          {
            GroupId: "sg-via-lt",
            IpPermissions: [
              { IpProtocol: "tcp", FromPort: 22, ToPort: 22, IpRanges: [{ CidrIp: "0.0.0.0/0" }] },
            ],
          },
        ],
      },
    });

    const { resources, edges } = await observeAwsDependencies({ observed: observedInstanceOnly });

    // The indirect hop — the one a flat describe-instances sweep misses, and
    // the reason effectiveIngress is a fold rather than a passthrough.
    expect(resources["lt-1"]).toMatchObject({ type: "AWS::EC2::LaunchTemplate" });
    expect(resources["sg-via-lt"]).toMatchObject({ type: "AWS::EC2::SecurityGroup" });
    expect(edges).toContainEqual({ from: "webServer", to: "lt-1", kind: "ref", viaAttr: "LaunchTemplateId" });
    expect(edges).toContainEqual({ from: "lt-1", to: "sg-via-lt", kind: "ref", viaAttr: "SecurityGroupIds" });
  });

  it("an instance with no internet route still reports its groups", async () => {
    // effectiveIngress is asked about instances that are not internet-facing
    // too; guarding must not be conditional on routing.
    respond({
      "ec2 describe-instances": {
        Reservations: [
          { Instances: [{ InstanceId: "i-1", SubnetId: "subnet-private", SecurityGroups: [{ GroupId: "sg-shared" }] }] },
        ],
      },
      "ec2 describe-route-tables": { RouteTables: [] },
      "ec2 describe-security-groups": { SecurityGroups: [{ GroupId: "sg-shared", IpPermissions: [] }] },
    });

    const { resources } = await observeAwsDependencies({ observed: observedInstanceOnly });
    expect(resources["sg-shared"]).toBeDefined();
  });
});
