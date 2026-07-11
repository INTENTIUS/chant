import { describe, it, expect } from "vitest";
import { buildLiveGraphIr, type LiveObservation } from "./graph-ir";

// A fixture "snapshot" — what a lexicon's describeResources() returns for a live
// environment (managed-only). Two AWS resources; the subnet references the VPC by
// physical id (that reference is #778's job, not this one — here we only project
// nodes).
const observations: LiveObservation[] = [
  {
    lexicon: "aws",
    resources: {
      "web-vpc": {
        type: "AWS::EC2::VPC",
        status: "CREATE_COMPLETE",
        physicalId: "vpc-0a1b",
        attributes: { CidrBlock: "10.0.0.0/16" },
        ownership: "owned",
      },
      "app-subnet": {
        type: "AWS::EC2::Subnet",
        status: "CREATE_COMPLETE",
        physicalId: "subnet-0c2d",
        attributes: { VpcId: "vpc-0a1b", CidrBlock: "10.0.1.0/24" },
        ownership: "owned",
      },
    },
  },
];

describe("buildLiveGraphIr", () => {
  it("projects observed resources into IR nodes — nodes only, no edges", () => {
    const ir = buildLiveGraphIr(observations);
    expect(ir.nodes.map((n) => n.id)).toEqual(["app-subnet", "web-vpc"]); // sorted
    expect(ir.edges).toEqual([]);
  });

  it("carries kind, lexicon, physicalId, ownership, and live attrs on each node", () => {
    const ir = buildLiveGraphIr(observations);
    const vpc = ir.nodes.find((n) => n.id === "web-vpc")!;
    expect(vpc.kind).toBe("AWS::EC2::VPC");
    expect(vpc.lexicon).toBe("aws");
    expect(vpc.physicalId).toBe("vpc-0a1b"); // the reference index key for #778
    expect(vpc.ownership).toBe("owned");
    expect(vpc.attrs).toEqual({ CidrBlock: "10.0.0.0/16" });
  });

  it("groups by lexicon and stack", () => {
    const ir = buildLiveGraphIr(observations);
    expect(ir.groups.byLexicon).toEqual({ aws: ["app-subnet", "web-vpc"] });
    expect(ir.groups.byStack).toEqual({ aws: ["app-subnet", "web-vpc"] });
  });

  it("omits physicalId/ownership when the observation lacks them", () => {
    const ir = buildLiveGraphIr([
      { lexicon: "k8s", resources: { pod: { type: "Pod", status: "Running" } } },
    ]);
    const node = ir.nodes[0];
    expect(node.physicalId).toBeUndefined();
    expect(node.ownership).toBeUndefined();
    expect(node.attrs).toEqual({});
  });

  it("is deterministic for a fixed observation set", () => {
    expect(JSON.stringify(buildLiveGraphIr(observations))).toBe(
      JSON.stringify(buildLiveGraphIr(observations)),
    );
  });
});
