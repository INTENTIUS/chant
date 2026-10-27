// Engine facts on graph nodes and edge grain (#4527, designed on #4520).
import { describe, it, expect } from "vitest";
import { buildLiveGraphIr, sourceOverlayGraphs, type GraphIR, type LiveObservation } from "./graph-ir";
import type { EngineFacts } from "./engine-facts";

const facts: EngineFacts = {
  ownership: "bound",
  ownedBy: "marker",
  markers: { owner: "web", address: "aws_s3_bucket.logs", encoding: "escaped", source: "live" },
  cloudIds: [{ kind: "import-id", value: "web-logs" }],
  observedAt: "2026-10-26T12:00:00Z",
};

describe("buildLiveGraphIr: engine facts (#4527)", () => {
  it("copies ResourceMetadata.facts onto the node beside physicalId", () => {
    const ir = buildLiveGraphIr([
      { lexicon: "terraform", resources: { "aws_s3_bucket.logs": { type: "aws_s3_bucket", status: "present", physicalId: "web-logs", facts } } },
    ]);
    const node = ir.nodes[0]!;
    expect(node.physicalId).toBe("web-logs");
    expect(node.facts).toEqual(facts);
  });

  it("leaves IRNode.ownership to the metadata's own verdict, whatever the facts say", () => {
    const ir = buildLiveGraphIr([
      {
        lexicon: "terraform",
        resources: { q: { type: "aws_sqs_queue", status: "present", ownership: "unknown", facts: { ownership: "foreign" } } },
      },
    ]);
    expect(ir.nodes[0]!.ownership).toBeUndefined();
    expect(ir.nodes[0]!.facts).toEqual({ ownership: "foreign" });
  });

  it("adds no facts field when the observation has none", () => {
    const ir = buildLiveGraphIr([{ lexicon: "aws", resources: { b: { type: "AWS::S3::Bucket", status: "CREATE_COMPLETE" } } }]);
    expect("facts" in ir.nodes[0]!).toBe(false);
  });

  it("copies an instance's facts onto its instance node", () => {
    const instanceFacts: EngineFacts = { ownership: "bound", ownedBy: "record", cloudIds: [{ kind: "import-id", value: "eipalloc-1" }] };
    const ir = buildLiveGraphIr([
      {
        lexicon: "terraform",
        resources: {
          "aws_eip.pool": {
            type: "aws_eip",
            status: "present",
            instances: [
              { key: "[0]", address: "aws_eip.pool[0]", verdict: "present", physicalId: "eipalloc-0", facts: { ownership: "pending" } },
              { key: "[1]", address: "aws_eip.pool[1]", verdict: "present", physicalId: "eipalloc-1", facts: instanceFacts },
              { key: "[2]", address: "aws_eip.pool[2]", verdict: "present" },
            ],
          },
        },
      },
    ]);
    const byId = new Map(ir.nodes.map((n) => [n.id, n]));
    expect(byId.get("aws_eip.pool[0]")!.facts).toEqual({ ownership: "pending" });
    expect(byId.get("aws_eip.pool[1]")!.facts).toEqual(instanceFacts);
    expect("facts" in byId.get("aws_eip.pool[2]")!).toBe(false);
    expect("facts" in byId.get("aws_eip.pool")!).toBe(false);
  });
});

describe("buildLiveGraphIr: edge grain (#4527)", () => {
  const pair = {
    lexicon: "pulumi",
    resources: {
      policy: { type: "aws:s3/bucketPolicy:BucketPolicy", status: "present" },
      bucket: { type: "aws:s3/bucketV2:BucketV2", status: "present" },
    },
  } satisfies LiveObservation;

  it("passes grain through unchanged", () => {
    const ir = buildLiveGraphIr([{ ...pair, edges: [{ from: "policy", to: "bucket", kind: "ref", viaAttr: "dependencies", grain: "instance" }] }]);
    expect(ir.edges).toEqual([{ from: "policy", to: "bucket", kind: "ref", viaAttr: "dependencies", grain: "instance" }]);
  });

  it("keeps two edges between the same pair that differ only in grain", () => {
    const ir = buildLiveGraphIr([
      {
        ...pair,
        edges: [
          { from: "policy", to: "bucket", kind: "ref", viaAttr: "dependencies", grain: "instance" },
          { from: "policy", to: "bucket", kind: "ref", viaAttr: "dependencies", grain: "block" },
          { from: "policy", to: "bucket", kind: "ref", viaAttr: "dependencies" },
        ],
      },
    ]);
    expect(ir.edges.map((e) => e.grain)).toEqual([undefined, "block", "instance"]);
  });

  it("still dedupes edges with the same grain", () => {
    const edge = { from: "policy", to: "bucket", kind: "ref" as const, viaAttr: "dependencies", grain: "instance" as const };
    const ir = buildLiveGraphIr([{ ...pair, edges: [edge] }, { ...pair, edges: [edge] }]);
    expect(ir.edges).toHaveLength(1);
  });
});

describe("sourceOverlayGraphs: engine facts and grain (#4527)", () => {
  const n = (id: string) => ({ id, kind: "aws_s3_bucket", lexicon: "terraform", attrs: {} });
  const declared: GraphIR = { nodes: [n("aws_s3_bucket.logs"), n("aws_s3_bucket.planned")], edges: [], groups: {} };
  const live: GraphIR = {
    nodes: [
      { ...n("aws_s3_bucket.logs"), physicalId: "web-logs", facts },
      { ...n("aws_s3_bucket.stray"), facts: { ownership: "unowned" } },
    ],
    edges: [
      { from: "aws_s3_bucket.stray", to: "aws_s3_bucket.logs", kind: "ref", viaAttr: "dependencies", grain: "block" },
      { from: "aws_s3_bucket.stray", to: "aws_s3_bucket.logs", kind: "ref", viaAttr: "dependencies", grain: "instance" },
    ],
    groups: {},
  };

  it("carries the observed facts onto the managed declared node, as it does physicalId", () => {
    const ir = sourceOverlayGraphs(declared, live);
    const logs = ir.nodes.find((x) => x.id === "aws_s3_bucket.logs")!;
    expect(logs.physicalId).toBe("web-logs");
    expect(logs.facts).toEqual(facts);
    expect("facts" in ir.nodes.find((x) => x.id === "aws_s3_bucket.planned")!).toBe(false);
  });

  it("keeps a foreign node's facts and both grains of its live edges", () => {
    const ir = sourceOverlayGraphs(declared, live);
    expect(ir.nodes.find((x) => x.id === "aws_s3_bucket.stray")!.facts).toEqual({ ownership: "unowned" });
    expect(ir.edges.map((e) => e.grain).sort()).toEqual(["block", "instance"]);
  });
});
