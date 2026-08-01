import { describe, it, expect, vi, beforeEach } from "vitest";

const spawnMock = vi.fn();
vi.mock("@intentius/chant/runtime-adapter", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@intentius/chant/runtime-adapter")>();
  return { ...actual, getRuntime: () => ({ ...actual.getRuntime(), spawn: spawnMock }) };
});

const { describeOwnProperties, canDescribe, stampRegion } = await import("./properties");

const ok = (body: unknown) => ({ stdout: JSON.stringify(body), stderr: "", exitCode: 0 });
const fail = { stdout: "", stderr: "InvalidInstanceID.NotFound", exitCode: 255 };

const instance = (id: string, vpc: string) => ({ InstanceId: id, VpcId: vpc });
const reservations = (...rows: Array<Record<string, unknown>>) => ({
  Reservations: [{ Instances: rows }],
});

// #1279 — `describe-stack-resources` returns identity and nothing about the
// resource, so the observation had been filling `attributes` with the *stack's*
// outputs, copied onto every member. No node carried its own VpcId.
describe("describeOwnProperties (#1279)", () => {
  beforeEach(() => spawnMock.mockReset());

  const observed = {
    web: { type: "AWS::EC2::Instance", status: "OK", physicalId: "i-1" },
    api: { type: "AWS::EC2::Instance", status: "OK", physicalId: "i-2" },
  };

  it("joins each resource's own properties back by physical id", async () => {
    spawnMock.mockResolvedValue(ok(reservations(instance("i-1", "vpc-a"), instance("i-2", "vpc-b"))));
    const { resources: merged } = await describeOwnProperties(observed);
    expect(merged.web.attributes?.VpcId).toBe("vpc-a");
    expect(merged.api.attributes?.VpcId).toBe("vpc-b");
  });

  it("reads a kind once for the whole observation, not once per resource", async () => {
    spawnMock.mockResolvedValue(ok(reservations(instance("i-1", "vpc-a"), instance("i-2", "vpc-b"))));
    await describeOwnProperties(observed);
    expect(spawnMock).toHaveBeenCalledTimes(1);
  });

  it("keeps stack outputs, and lets the resource's own property win the name", async () => {
    const withOutputs = {
      web: {
        type: "AWS::EC2::Instance",
        status: "OK",
        physicalId: "i-1",
        attributes: { expVpcId: "vpc-exported", VpcId: "stale" },
      },
    };
    spawnMock.mockResolvedValue(ok(reservations(instance("i-1", "vpc-a"))));
    const { resources: merged } = await describeOwnProperties(withOutputs);
    expect(merged.web.attributes?.expVpcId).toBe("vpc-exported");
    expect(merged.web.attributes?.VpcId).toBe("vpc-a");
  });

  it("falls back to one call per id when the batch fails on a single bad id", async () => {
    // AWS fails the whole call on one unknown id. A snapshot naming an instance
    // that has since been terminated would otherwise take every other
    // instance's properties down with it — and the empty result is
    // indistinguishable from "the account has nothing to say".
    spawnMock
      .mockResolvedValueOnce(fail) // the batch, killed by i-2
      .mockResolvedValueOnce(ok(reservations(instance("i-1", "vpc-a"))))
      .mockResolvedValueOnce(fail); // i-2 really is gone
    const { resources: merged } = await describeOwnProperties(observed);
    expect(merged.web.attributes?.VpcId).toBe("vpc-a");
    expect(merged.api.attributes).toBeUndefined();
  });

  it("leaves the observation untouched when the kind cannot be read at all", async () => {
    spawnMock.mockResolvedValue(fail);
    const { resources: merged } = await describeOwnProperties({ web: observed.web });
    expect(merged.web.attributes).toBeUndefined();
  });

  // #1206: these attributes are compared by `lifecycle diff`, so a read that
  // fails after the resource is already identified reports every recorded
  // property as removed. The caller can only avoid that if the failure is told.
  it("reports a total failure, so a caller can call it a hole rather than thin data", async () => {
    spawnMock.mockResolvedValue({ stdout: "", stderr: "spawn aws ENOENT", exitCode: 127 });
    const result = await describeOwnProperties({ web: observed.web });
    expect(result.transportFailed).toBe(true);
    expect(result.failures.get("AWS::EC2::Instance")).toContain("ec2 describe-instances");
    expect(result.failures.get("AWS::EC2::Instance")).toContain("ENOENT");
  });

  it("a per-id retry that fails for every id is a failed kind, not an empty one", async () => {
    // The batch dies, then so does every retry. Before #1206 the retry path
    // replaced the null with `[]`, which read as "the account has nothing".
    spawnMock.mockResolvedValue(fail);
    const result = await describeOwnProperties(observed);
    expect(result.transportFailed).toBe(true);
  });

  it("a kind that answers keeps the pass best-effort, even when another fails", async () => {
    // One kind readable, one not: still detail-loss, not a hole. Only a total
    // failure changes the caller's verdict.
    spawnMock.mockImplementation((argv?: string[]) =>
      Promise.resolve(argv?.includes("describe-instances") ? ok(reservations(instance("i-1", "vpc-a"))) : fail),
    );
    const result = await describeOwnProperties({
      web: observed.web,
      net: { type: "AWS::EC2::Subnet", status: "OK", physicalId: "subnet-1" },
    });
    expect(result.transportFailed).toBe(false);
    expect(result.resources.web.attributes?.VpcId).toBe("vpc-a");
  });

  it("does not call out for a kind it cannot describe", async () => {
    const { resources: merged } = await describeOwnProperties({
      fn: { type: "AWS::Lambda::Function", status: "OK", physicalId: "fn-1" },
    });
    expect(spawnMock).not.toHaveBeenCalled();
    expect(merged.fn.attributes).toBeUndefined();
    expect(canDescribe("AWS::Lambda::Function")).toBe(false);
  });
});

// #1279 — the observation is scoped per stack and each stack declares its
// region, so the reader knew this and threw it away.
describe("stampRegion (#1279)", () => {
  const one = { web: { type: "AWS::EC2::Instance", status: "OK", physicalId: "i-1" } };

  it("records the region the resource was observed in", () => {
    expect(stampRegion(one, "us-west-2").web.attributes?.region).toBe("us-west-2");
  });

  it("keeps the properties already read", () => {
    const withProps = { web: { ...one.web, attributes: { VpcId: "vpc-a" } } };
    const out = stampRegion(withProps, "us-west-2").web.attributes;
    expect(out).toMatchObject({ VpcId: "vpc-a", region: "us-west-2" });
  });

  it("falls back to the region the call would have used", () => {
    const prev = process.env.AWS_REGION;
    process.env.AWS_REGION = "eu-west-1";
    try {
      expect(stampRegion(one).web.attributes?.region).toBe("eu-west-1");
    } finally {
      if (prev === undefined) delete process.env.AWS_REGION;
      else process.env.AWS_REGION = prev;
    }
  });
});
