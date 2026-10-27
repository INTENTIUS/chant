/**
 * #4521 on the aws lexicon: Cloud Control's type names mapped to kinds, a
 * fixture listing typed into nodes, and a capability that answers the same
 * over the indexed fixture as over the equivalent declared graph.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { GraphIR } from "@intentius/chant/graph-ir";
import { typeListing, type ListingLexicon, type ListingResult } from "@intentius/chant/lifecycle/type-listing";
import { CapabilityEngine } from "@intentius/chant/capabilities/matcher";
import { buildView, displayName } from "@intentius/chant/capabilities/view";
import { resolvePacks, shippedRules } from "@intentius/chant/capabilities/catalog";
import { MASKED } from "@intentius/chant/deep-observation";
import { awsCapabilityPack } from "./capabilities/pack";
import { awsKindForListedType, awsListedTypeForKind } from "./listed-types";
import { awsPlugin } from "./plugin";

const here = import.meta.dirname;
const surface = JSON.parse(readFileSync(join(here, "..", "surface.snapshot.json"), "utf-8")) as {
  entries: Record<string, { kind: string; resourceType: string }>;
};
const KINDS: ReadonlySet<string> = new Set(
  Object.values(surface.entries).filter((e) => e.kind === "resource").map((e) => e.resourceType),
);
const listing = JSON.parse(readFileSync(join(here, "testdata", "indexed", "listing.json"), "utf-8")) as ListingResult;

// The plugin's own hooks, with the kind set pinned to the checked-in surface so
// the test does not depend on whether `chant generate` has run.
const aws: ListingLexicon = {
  name: awsPlugin.name,
  deepNormalizationHooks: awsPlugin.deepNormalizationHooks,
  listedTypes: { ...awsPlugin.listedTypes!, kindFor: (t) => awsKindForListedType(t, KINDS) },
};

describe("Cloud Control types to aws kinds", () => {
  it("every aws resource kind has a listed type that maps back to it", () => {
    const missing = [...KINDS].filter((k) => awsKindForListedType(awsListedTypeForKind(k), KINDS) !== k);
    expect(missing).toEqual([]);
    expect(KINDS.size).toBeGreaterThan(1000);
  });

  it("a type outside the lexicon, or not a CloudFormation name, has no kind", () => {
    expect(awsKindForListedType("AWS::IoTFleetHub::Application", KINDS)).toBeUndefined();
    expect(awsKindForListedType("aws_s3_bucket", KINDS)).toBeUndefined();
  });

  it("the plugin declares the mapping for the aws substrate", () => {
    expect(awsPlugin.listedTypes?.substrate).toBe("aws");
  });
});

describe("the aws fixture listing as typed nodes", () => {
  const doc = typeListing(listing, [aws]);

  it("produces a typed node per mapped object, and an unknown-kind node for the rest", () => {
    expect(doc.graph.nodes.map((n) => [n.nativeId, n.kind, n.unmappedKind ?? false])).toEqual([
      ["vol-0a1b2c3d4e5f60718", "AWS::EC2::Volume", false],
      ["fleet-console", "AWS::IoTFleetHub::Application", true],
      ["orders-db", "AWS::RDS::DBInstance", false],
      ["reports-db", "AWS::RDS::DBInstance", false],
      ["shop-assets", "AWS::S3::Bucket", false],
    ]);
    expect(doc.graph.nodes).toHaveLength(listing.resources.length);
  });

  it("normalizes through the aws hooks: read-only properties pruned, secrets masked", () => {
    const bucket = doc.graph.nodes.find((n) => n.nativeId === "shop-assets")!;
    expect(bucket.attrs).toEqual({ BucketName: "shop-assets" });
    const db = doc.graph.nodes.find((n) => n.nativeId === "orders-db")!;
    expect(db.attrs.MasterUserPassword).toBe(MASKED);
    expect(db.attrs.StorageEncrypted).toBe(true);
    expect(db.facts?.markers).toEqual({ owner: "shop", encoding: "escaped", source: "live" });
  });

  it("encrypted-at-rest matches the same resources over the index as over the declared graph", () => {
    // The declared form of the same three resources, as source would carry them.
    const declared: GraphIR = {
      nodes: [
        { id: "orders-db", kind: "AWS::RDS::DBInstance", lexicon: "aws", attrs: { DBInstanceIdentifier: "orders-db", Engine: "postgres", StorageEncrypted: true } },
        { id: "reports-db", kind: "AWS::RDS::DBInstance", lexicon: "aws", attrs: { DBInstanceIdentifier: "reports-db", Engine: "postgres", StorageEncrypted: false } },
        { id: "vol-0a1b2c3d4e5f60718", kind: "AWS::EC2::Volume", lexicon: "aws", attrs: { AvailabilityZone: "us-east-1a", Size: 20, Encrypted: true } },
        { id: "shop-assets", kind: "AWS::S3::Bucket", lexicon: "aws", attrs: { BucketName: "shop-assets" } },
      ],
      edges: [],
      groups: {},
    };
    const answer = (g: GraphIR) => {
      const e = new CapabilityEngine(buildView(g, resolvePacks([awsCapabilityPack])), shippedRules().rules);
      return [...e.set("encrypted-at-rest", e.bind("encrypted-at-rest", [] as never)).keys()].map(displayName).sort();
    };
    expect(answer(declared)).toEqual(["orders-db", "vol-0a1b2c3d4e5f60718"]);
    expect(answer(doc.graph)).toEqual(answer(declared));
  });
});
