// Engine facts on graph nodes and edge grain (#4527, designed on #4520).
import { describe, it, expect } from "vitest";
import { buildGraphIr, buildLiveGraphIr, entityFacts, sourceOverlayGraphs, type GraphIR, type LiveObservation } from "./graph-ir";
import { DECLARABLE_MARKER, type Declarable } from "./declarable";
import { ENGINE_FACTS_FLOOR, type EngineFacts } from "./engine-facts";
import { NEXT_RELEASE } from "./release-floors";

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

describe("buildGraphIr: an entity's facts and reference grain (#4529)", () => {
  // The shape the pulumi lexicon's member read gives a plunge member's entity.
  function entity(type: string, references: unknown[], withFacts?: EngineFacts): Declarable {
    const e = { lexicon: "pulumi", entityType: type, kind: "resource", props: {}, references, [DECLARABLE_MARKER]: true };
    if (withFacts) Object.defineProperty(e, "facts", { value: withFacts, enumerable: false });
    return e as unknown as Declarable;
  }

  it("copies an entity's facts onto its node, and keeps them out of attrs", () => {
    const ir = buildGraphIr(new Map([["m/a", entity("aws:s3/bucket:Bucket", [], facts)]]));
    expect(ir.nodes[0]!.facts).toEqual(facts);
    expect(ir.nodes[0]!.attrs).toEqual({});
  });

  it("keeps an enumerable facts field out of attrs too", () => {
    const e = { ...(entity("aws:s3/bucket:Bucket", []) as unknown as Record<string, unknown>), facts };
    const ir = buildGraphIr(new Map([["m/a", e as unknown as Declarable]]));
    expect(ir.nodes[0]!.facts).toEqual(facts);
    expect(ir.nodes[0]!.attrs).toEqual({});
  });

  it("adds no facts field to an entity with none", () => {
    expect(entityFacts(entity("x", []))).toBeUndefined();
    expect("facts" in buildGraphIr(new Map([["m/a", entity("x", [])]])).nodes[0]!).toBe(false);
  });

  it("passes a reference's grain to its edge, and two grains between one pair are two edges", () => {
    const ir = buildGraphIr(
      new Map([
        ["m/a", entity("x", [{ to: "m/b", viaAttr: "bucket", grain: "property" }, { to: "m/b", viaAttr: "bucket", grain: "instance" }, { to: "m/b", viaAttr: "dependencies" }])],
        ["m/b", entity("y", [{ to: "m/a", viaAttr: "parent", grain: "sideways" }])],
      ]),
    );
    expect(ir.edges.map((e) => [e.from, e.viaAttr, e.grain ?? null])).toEqual([
      ["m/a", "bucket", "instance"],
      ["m/a", "bucket", "property"],
      ["m/a", "dependencies", null],
      // A grain outside the three is not carried.
      ["m/b", "parent", null],
    ]);
  });

  it("names its floor as the next release", () => {
    expect(ENGINE_FACTS_FLOOR).toBe(NEXT_RELEASE);
  });
});
