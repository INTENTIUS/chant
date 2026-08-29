import { describe, it, expect, vi, beforeEach } from "vitest";
import type { LifecycleSnapshot } from "./types";

// `replaySnapshots` reads the orphan branch through this one function, so the
// stored set is the whole input surface.
const stored = new Map<string, string>();
vi.mock("./git", () => ({
  readEnvironmentSnapshots: async (): Promise<Map<string, string>> => stored,
}));

const { replaySnapshots } = await import("./replay");

/** One region's recorded stack: an instance it manages, plus ambient resources. */
function snapshot(
  stack: string,
  region: string,
  opts: {
    ambient?: Record<string, { type: string; physicalId?: string }>;
    managed?: Record<string, string>;
    edges?: Array<{ from: string; to: string; kind: "ref" }>;
  } = {},
): string {
  const snap: LifecycleSnapshot = {
    lexicon: "aws",
    environment: "prod",
    stack,
    commit: "abc123",
    timestamp: "2026-08-03T00:00:00.000Z",
    resources: {
      ...Object.fromEntries(
        Object.entries(opts.managed ?? {}).map(([name, physicalId]) => [
          name,
          { type: "AWS::EC2::Instance", status: "OBSERVED", physicalId },
        ]),
      ),
      ...Object.fromEntries(
        Object.entries(opts.ambient ?? {}).map(([id, meta]) => [
          id,
          {
            type: meta.type,
            status: "OBSERVED",
            physicalId: meta.physicalId ?? id,
            ambient: true,
            ownership: "foreign" as const,
            // What `stampRegion` puts there on the real path (#1279).
            attributes: { region },
          },
        ]),
      ),
    },
    ...(opts.edges ? { edges: opts.edges } : {}),
  };
  return JSON.stringify(snap);
}

function keys(observations: Array<{ resources: Record<string, unknown> }>): string[] {
  return observations.flatMap((o) => Object.keys(o.resources)).sort();
}

beforeEach(() => {
  stored.clear();
});

describe("replaySnapshots — ambient identity across regions (#1416)", () => {
  it("keeps each region's copy when the ids collide", async () => {
    // What Floci does (lex00/floci#21): the default VPC and its subnets carry
    // the same id strings in every region. Real AWS ids are globally unique, so
    // this is only observable against the emulator — but the merge is the same
    // merge either way.
    for (const region of ["us-east-1", "us-west-1", "us-west-2"]) {
      stored.set(`${region}__aws`, snapshot(region, region, {
        ambient: {
          "vpc-default": { type: "AWS::EC2::VPC" },
          "subnet-default-a": { type: "AWS::EC2::Subnet" },
          "subnet-default-b": { type: "AWS::EC2::Subnet" },
        },
      }));
    }

    const result = await replaySnapshots("prod", "latest", new Set());
    if ("error" in result) throw new Error(result.error);

    // Nine ambient resources went in; before this fix three came out.
    expect(keys(result.observations)).toEqual([
      "us-east-1::subnet-default-a",
      "us-east-1::subnet-default-b",
      "us-east-1::vpc-default",
      "us-west-1::subnet-default-a",
      "us-west-1::subnet-default-b",
      "us-west-1::vpc-default",
      "us-west-2::subnet-default-a",
      "us-west-2::subnet-default-b",
      "us-west-2::vpc-default",
    ]);
  });

  it("still merges one region's resource seen from two stacks", async () => {
    // The case the account-level rule was written for: two stacks in the same
    // region each recorded the region's default security group. That is one
    // group, and counting it twice would inflate every count over it.
    stored.set("web__aws", snapshot("web", "us-east-1", {
      ambient: { "sg-default": { type: "AWS::EC2::SecurityGroup" } },
    }));
    stored.set("api__aws", snapshot("api", "us-east-1", {
      ambient: { "sg-default": { type: "AWS::EC2::SecurityGroup" } },
    }));

    const result = await replaySnapshots("prod", "latest", new Set());
    if ("error" in result) throw new Error(result.error);
    expect(keys(result.observations)).toEqual(["us-east-1::sg-default"]);
  });

  it("leaves a single recorded stack's ids exactly as recorded", async () => {
    // One stack is one region: nothing to merge, so nothing to disambiguate.
    // A single-region project's ids must not move.
    stored.set("main__aws", snapshot("main", "us-east-1", {
      ambient: { "sg-default": { type: "AWS::EC2::SecurityGroup" } },
      managed: { web: "i-123" },
    }));

    const result = await replaySnapshots("prod", "latest", new Set());
    if ("error" in result) throw new Error(result.error);
    expect(keys(result.observations)).toEqual(["sg-default", "web"]);
  });

  it("does not region-qualify a managed resource", async () => {
    // Managed ids join the declared canvas, which qualifies by stack or not at
    // all. Region-qualifying `web` would unjoin it from its own declaration.
    for (const region of ["us-east-1", "us-west-1"]) {
      stored.set(`${region}__aws`, snapshot(region, region, { managed: { web: `i-${region}` } }));
    }

    const result = await replaySnapshots("prod", "latest", new Set(["us-east-1", "us-west-1"]));
    if ("error" in result) throw new Error(result.error);
    expect(keys(result.observations)).toEqual(["us-east-1::web", "us-west-1::web"]);
  });

  it("leaves an ambient resource with no recorded region alone", async () => {
    // A resource carrying no region is account-level as far as anything here
    // can tell, and account-level is what the original merge assumed. IAM is
    // the shape: one policy, seen from every region's stack.
    const global = (stack: string): string =>
      JSON.stringify({
        lexicon: "aws",
        environment: "prod",
        stack,
        commit: "abc123",
        timestamp: "2026-08-03T00:00:00.000Z",
        resources: {
          "arn:aws:iam::1:policy/p": {
            type: "AWS::IAM::Policy",
            status: "OBSERVED",
            physicalId: "arn:aws:iam::1:policy/p",
            ambient: true,
          },
        },
      } satisfies LifecycleSnapshot);
    stored.set("us-east-1__aws", global("us-east-1"));
    stored.set("us-west-1__aws", global("us-west-1"));

    const result = await replaySnapshots("prod", "latest", new Set());
    if ("error" in result) throw new Error(result.error);
    expect(keys(result.observations)).toEqual(["arn:aws:iam::1:policy/p"]);
  });

  it("re-points edges at the keys the resources ended up under", async () => {
    // An edge naming `subnet-default-a` has to reach the copy in ITS region,
    // not whichever region sorted first. A dangling edge is worse than the
    // collision it replaced: the node is present and simply unreachable.
    for (const region of ["us-east-1", "us-west-1"]) {
      stored.set(`${region}__aws`, snapshot(region, region, {
        ambient: {
          "subnet-default-a": { type: "AWS::EC2::Subnet" },
          "eni-1": { type: "AWS::EC2::NetworkInterface" },
        },
        edges: [{ from: "eni-1", to: "subnet-default-a", kind: "ref" }],
      }));
    }

    const result = await replaySnapshots("prod", "latest", new Set());
    if ("error" in result) throw new Error(result.error);
    const edges = result.observations.flatMap((o) => o.edges ?? []);
    expect(edges).toEqual([
      { from: "us-east-1::eni-1", to: "us-east-1::subnet-default-a", kind: "ref" },
      { from: "us-west-1::eni-1", to: "us-west-1::subnet-default-a", kind: "ref" },
    ]);
    // Every endpoint resolves to a node that exists.
    const nodes = new Set(keys(result.observations));
    for (const edge of edges) {
      expect(nodes.has(edge.from)).toBe(true);
      expect(nodes.has(edge.to)).toBe(true);
    }
  });
});

describe("a resource recorded twice is one node (#1432 follow-up)", () => {
  // A subnet its stack declares, ALSO recorded as a dependency because
  // instances reference it. Same physical subnet, two entries.
  function snap(stack: string): string {
    return JSON.stringify({
      lexicon: "aws", environment: "prod", stack,
      commit: "abc", timestamp: "2026-08-03T00:00:00.000Z",
      resources: {
        publicSubnet: { type: "AWS::EC2::Subnet", status: "OBSERVED", physicalId: "subnet-9af06b90" },
        "subnet-9af06b90": {
          type: "AWS::EC2::Subnet", status: "OBSERVED", physicalId: "subnet-9af06b90",
          referencedBy: ["webServer"],
        },
        webServer: { type: "AWS::EC2::Instance", status: "OBSERVED", physicalId: "i-1" },
      },
      edges: [{ from: "webServer", to: "subnet-9af06b90", kind: "ref", viaAttr: "SubnetId" }],
    });
  }

  it("drops the duplicate rather than counting the subnet twice", async () => {
    stored.set("main__aws", snap("main"));
    const result = await replaySnapshots("prod", "latest", new Set());
    if ("error" in result) throw new Error(result.error);
    expect(keys(result.observations)).toEqual(["publicSubnet", "webServer"]);
  });

  it("re-points the dropped duplicate's edges at the survivor", async () => {
    // Dropping the node alone would take this edge with it: buildLiveGraphIr
    // discards an edge whose endpoints were not both observed, so the instance
    // would stop being in any subnet at all.
    stored.set("main__aws", snap("main"));
    const result = await replaySnapshots("prod", "latest", new Set());
    if ("error" in result) throw new Error(result.error);
    expect(result.observations.flatMap((o) => o.edges ?? [])).toEqual([
      { from: "webServer", to: "publicSubnet", kind: "ref", viaAttr: "SubnetId" },
    ]);
  });

  it("keeps a dependency nothing manages", async () => {
    // The account's default route table: referenced, managed by nobody. It is
    // not a duplicate and must survive.
    stored.set("main__aws", JSON.stringify({
      lexicon: "aws", environment: "prod", stack: "main",
      commit: "abc", timestamp: "2026-08-03T00:00:00.000Z",
      resources: {
        "rtb-default": {
          type: "AWS::EC2::RouteTable", status: "OBSERVED", physicalId: "rtb-default",
          referencedBy: ["webServer"],
        },
      },
    }));
    const result = await replaySnapshots("prod", "latest", new Set());
    if ("error" in result) throw new Error(result.error);
    expect(keys(result.observations)).toEqual(["rtb-default"]);
  });
});

describe("replaySnapshots — recorded depth (#1268)", () => {
  it("reports identity when nothing recorded deeper", async () => {
    stored.set("main__aws", snapshot("main", "us-east-1", { managed: { web: "i-1" } }));
    const result = await replaySnapshots("prod", "latest", new Set());
    if ("error" in result) throw new Error(result.error);
    expect(result.depth).toBe("identity");
  });

  it("reports deep when any recorded lexicon read that deep", async () => {
    stored.set("main__aws", JSON.stringify({
      lexicon: "aws", environment: "prod", stack: "main",
      commit: "abc", timestamp: "2026-08-03T00:00:00.000Z", depth: "deep",
      resources: { web: { type: "AWS::EC2::Instance", status: "OBSERVED", physicalId: "i-1" } },
    }));
    stored.set("net__aws", JSON.stringify({
      lexicon: "aws", environment: "prod", stack: "net",
      commit: "abc", timestamp: "2026-08-03T00:00:00.000Z",
      resources: { vpc: { type: "AWS::EC2::VPC", status: "OBSERVED", physicalId: "vpc-1" } },
    }));
    const result = await replaySnapshots("prod", "latest", new Set());
    if ("error" in result) throw new Error(result.error);
    expect(result.depth).toBe("deep");
  });
});
