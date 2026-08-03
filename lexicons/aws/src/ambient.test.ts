import { describe, it, expect, vi, beforeEach } from "vitest";

const spawnMock = vi.fn();
vi.mock("@intentius/chant/runtime-adapter", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@intentius/chant/runtime-adapter")>();
  return { ...actual, getRuntime: () => ({ ...actual.getRuntime(), spawn: spawnMock }) };
});

const { observeAwsAmbient, canEnumerate } = await import("./ambient");

const ok = (body: unknown) => ({ stdout: JSON.stringify(body), stderr: "", exitCode: 0 });
const GROUPS = {
  SecurityGroups: [
    { GroupId: "sg-default", GroupName: "default", VpcId: "vpc-1" },
    { GroupId: "sg-mine", GroupName: "web", VpcId: "vpc-1" },
    { GroupId: "sg-stray", GroupName: "leftover", VpcId: "vpc-1" },
  ],
};

// #1278 — a resource nothing points at is invisible to both other observation
// paths, because both resolve outward from what is declared. "Which of my
// security groups are unused" is a question about exactly those.
describe("observeAwsAmbient (#1278)", () => {
  beforeEach(() => spawnMock.mockReset());

  it("reports groups that exist but are not managed", async () => {
    spawnMock.mockResolvedValue(ok(GROUPS));
    const found = await observeAwsAmbient({
      kinds: ["AWS::EC2::SecurityGroup"],
      observed: { web: { type: "AWS::EC2::SecurityGroup", status: "OK", physicalId: "sg-mine" } },
    });
    // sg-mine is managed, so it is not ambient — it would otherwise be counted twice.
    expect(Object.keys(found).sort()).toEqual(["sg-default", "sg-stray"]);
    expect(found["sg-default"]).toMatchObject({ ambient: true, ownership: "foreign" });
  });

  it("carries the whole payload, leaving 'unused' to the graph", async () => {
    // Deciding attachment in the reader would put a conclusion in the
    // observation — the mistake liveInternetFacing made and #1271 undid.
    spawnMock.mockResolvedValue(ok(GROUPS));
    const found = await observeAwsAmbient({ kinds: ["AWS::EC2::SecurityGroup"], observed: {} });
    expect(found["sg-default"].attributes).toMatchObject({ GroupName: "default", VpcId: "vpc-1" });
  });

  // The empty ones are the answer, and they were the ones being dropped: both
  // other observers resolve outward from declarations, so a subnet is recorded
  // only when something in it is.
  it("reports subnets nothing occupies", async () => {
    spawnMock.mockResolvedValue(
      ok({
        Subnets: [
          { SubnetId: "subnet-used", VpcId: "vpc-1" },
          { SubnetId: "subnet-empty-a", VpcId: "vpc-default" },
          { SubnetId: "subnet-empty-b", VpcId: "vpc-default" },
        ],
      }),
    );
    const found = await observeAwsAmbient({
      kinds: ["AWS::EC2::Subnet"],
      observed: { public: { type: "AWS::EC2::Subnet", status: "OK", physicalId: "subnet-used" } },
    });
    expect(Object.keys(found).sort()).toEqual(["subnet-empty-a", "subnet-empty-b"]);
    expect(found["subnet-empty-a"].attributes).toMatchObject({ VpcId: "vpc-default" });
  });

  it("is bounded by the kinds the project declares", async () => {
    // A project managing security groups is not made to enumerate the account.
    const found = await observeAwsAmbient({ kinds: ["AWS::S3::Bucket"], observed: {} });
    expect(found).toEqual({});
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("targets the stack's region", async () => {
    spawnMock.mockResolvedValue(ok(GROUPS));
    await observeAwsAmbient({ kinds: ["AWS::EC2::SecurityGroup"], observed: {}, region: "us-west-2" });
    const argv = spawnMock.mock.calls[0][0] as string[];
    expect(argv).toContain("--region");
    expect(argv).toContain("us-west-2");
  });

  it("a failed enumeration yields nothing rather than throwing", async () => {
    spawnMock.mockResolvedValue({ stdout: "", stderr: "denied", exitCode: 255 });
    await expect(
      observeAwsAmbient({ kinds: ["AWS::EC2::SecurityGroup"], observed: {} }),
    ).resolves.toEqual({});
  });

  it("declares which kinds it can enumerate", () => {
    expect(canEnumerate("AWS::EC2::SecurityGroup")).toBe(true);
    expect(canEnumerate("AWS::EC2::Instance")).toBe(false);
  });
});
