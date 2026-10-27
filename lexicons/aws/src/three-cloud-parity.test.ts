/**
 * #4535: on example-three-cloud's dns member, the aws catalog draws the one
 * edge behold's matcher (behold src/value-match.ts) drew there: the gcp
 * latency record is a CNAME to the gcp origin record, by name. The three
 * records sharing `www.three-cloud.example.` make that name ambiguous, and
 * none of them is referenced by it.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { IRNode } from "@intentius/chant/graph-ir";
import { reconstructIndexedEdges } from "@intentius/chant/graph-refs";
import { awsReferenceCatalog } from "./reference-catalog";

const graph = JSON.parse(readFileSync(join(import.meta.dirname, "testdata", "three-cloud", "dns.graph.json"), "utf-8")) as {
  nodes: IRNode[];
  edges: Array<{ from: string; to: string }>;
};

describe("example-three-cloud's dns member (parity with behold's matcher)", () => {
  const out = reconstructIndexedEdges(graph.nodes, [{ lexicon: "aws", catalog: awsReferenceCatalog }], () => ({ account: "declared" }));
  const declared = new Set(graph.edges.map((e) => `${e.from}->${e.to}`));

  it("draws the CNAME edge the matcher drew, and none the declaration lacks besides", () => {
    expect(out.edges.filter((e) => !declared.has(`${e.from}->${e.to}`)).map((e) => `${e.from} -> ${e.to} (${e.rule})`)).toEqual([
      "dns/gcpRecord -> dns/gcpOrigin (aws:AWS::Route53::RecordSet:ResourceRecords[])",
    ]);
  });

  it("leaves nothing ambiguous or dangling", () => {
    expect(out.ambiguous).toEqual([]);
    expect(out.dangling).toEqual([]);
  });
});

describe("record and bucket identities (#4535)", () => {
  it("does not report a record value outside the estate as dangling", () => {
    const nodes: IRNode[] = [
      { id: "r", kind: "AWS::Route53::RecordSet", lexicon: "aws", attrs: { Name: "www.example.", Type: "CNAME", ResourceRecords: ["elsewhere.example.net."] } },
    ];
    const out = reconstructIndexedEdges(nodes, [{ lexicon: "aws", catalog: awsReferenceCatalog }], () => ({ account: "declared" }));
    expect(out.edges).toEqual([]);
    expect(out.dangling).toEqual([]);
  });

  it("names a bucket by its BucketName", () => {
    expect(awsReferenceCatalog.identities).toContainEqual({ kind: "AWS::S3::Bucket", ids: ["BucketName"] });
  });
});
