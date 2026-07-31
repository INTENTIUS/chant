import { describe, it, expect, vi, beforeEach } from "vitest";

const spawnMock = vi.fn();
vi.mock("@intentius/chant/runtime-adapter", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@intentius/chant/runtime-adapter")>();
  return { ...actual, getRuntime: () => ({ ...actual.getRuntime(), spawn: spawnMock }) };
});

const { describeOwnProperties, canDescribe } = await import("./properties");

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
    const merged = await describeOwnProperties(observed);
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
    const merged = await describeOwnProperties(withOutputs);
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
    const merged = await describeOwnProperties(observed);
    expect(merged.web.attributes?.VpcId).toBe("vpc-a");
    expect(merged.api.attributes).toBeUndefined();
  });

  it("leaves the observation untouched when the kind cannot be read at all", async () => {
    spawnMock.mockResolvedValue(fail);
    const merged = await describeOwnProperties({ web: observed.web });
    expect(merged.web.attributes).toBeUndefined();
  });

  it("does not call out for a kind it cannot describe", async () => {
    const merged = await describeOwnProperties({
      fn: { type: "AWS::Lambda::Function", status: "OK", physicalId: "fn-1" },
    });
    expect(spawnMock).not.toHaveBeenCalled();
    expect(merged.fn.attributes).toBeUndefined();
    expect(canDescribe("AWS::Lambda::Function")).toBe(false);
  });
});
