import { describe, expect, test } from "vitest";
import {
  canonicalScope,
  compactObservedAt,
  encodeIndexSegment,
  indexScopeKey,
  indexVersionName,
  isIndexVersionName,
  scopeDigest,
  validateIndexDocument,
  type IndexDocument,
  type IndexScope,
} from "./index-document";

// The store layout ruled on INTENTIUS/behold#1025 (2026-10-26), as #4519 builds it.
describe("index keys", () => {
  const cloud: IndexScope = { kind: "cloud", substrate: "aws", scopeId: "123456789012", locations: ["us-west-2", "us-east-1", "us-east-1"], types: "*" };

  test("two reads with the same flags share a scope path, in any order", () => {
    const reordered: IndexScope = { ...cloud, locations: ["us-east-1", "us-west-2"] };
    expect(scopeDigest(cloud)).toBe(scopeDigest(reordered));
    expect(indexScopeKey(cloud)).toBe(indexScopeKey(reordered));
    expect(canonicalScope(cloud)).toEqual({ kind: "cloud", substrate: "aws", scopeId: "123456789012", locations: ["us-east-1", "us-west-2"], types: "*" });
  });

  test("other regions or types write under another scope path", () => {
    expect(indexScopeKey({ ...cloud, locations: ["us-east-1"] })).not.toBe(indexScopeKey(cloud));
    expect(indexScopeKey({ ...cloud, types: ["AWS::S3::Bucket"] })).not.toBe(indexScopeKey(cloud));
  });

  test("index/<source>/<scopeId>/<scope digest>, each segment percent-encoded", () => {
    expect(indexScopeKey(cloud)).toMatch(/^cloud\/aws\/123456789012\/[0-9a-f]{12}$/);
    const gcp: IndexScope = { kind: "cloud", substrate: "gcp", scopeId: "projects/p:1", locations: "*", types: "*" };
    expect(indexScopeKey(gcp)).toMatch(/^cloud\/gcp\/projects%2Fp%3A1\/[0-9a-f]{12}$/);
    expect(indexScopeKey({ kind: "engine", engine: "plunge", project: "web", stack: "prod" })).toMatch(/^engine\/plunge\/web\/prod\/[0-9a-f]{12}$/);
    expect(indexScopeKey({ kind: "chant", member: ".", env: "prod", lexicon: "aws" })).toMatch(/^chant\/%2E\/prod\/-\/aws\/[0-9a-f]{12}$/);
    expect(encodeIndexSegment("..")).toBe("%2E%2E");
    expect(() => encodeIndexSegment("")).toThrow();
  });

  test("a version is <observedAt>-<digest12>.json and names sort in time order", () => {
    const digest = "a".repeat(64);
    expect(compactObservedAt("2026-10-26T09:14:03.120Z")).toBe("20261026T091403Z");
    expect(indexVersionName("2026-10-26T09:14:03.120Z", digest)).toBe("20261026T091403Z-aaaaaaaaaaaa.json");
    expect(indexVersionName("2026-10-26T09:14:03Z", `sha256:${"b".repeat(64)}`)).toBe("20261026T091403Z-bbbbbbbbbbbb.json");
    expect(isIndexVersionName("20261026T091403Z-aaaaaaaaaaaa.json")).toBe(true);
    expect(isIndexVersionName("scope.json")).toBe(false);
    expect(indexVersionName("2026-10-26T09:00:00Z", digest) < indexVersionName("2026-10-26T10:00:00Z", digest)).toBe(true);
    expect(() => indexVersionName("yesterday", digest)).toThrow();
    expect(() => indexVersionName("2026-10-26T09:00:00Z", "nothex")).toThrow();
  });

  test("a stamp that disagrees with itself is refused", () => {
    const doc = {
      index: "v1",
      stamp: { source: { kind: "cloud", name: "behold-lister" }, scope: cloud, scopeKey: indexScopeKey(cloud), observedAt: "2026-10-26T00:00:00Z", digest: "c".repeat(64) },
      coverage: [],
      graph: { version: 1, nodes: [], edges: [] },
    } as unknown as IndexDocument;
    expect(() => validateIndexDocument(doc)).not.toThrow();
    expect(() => validateIndexDocument({ ...doc, stamp: { ...doc.stamp, scopeKey: "cloud/aws/x" } })).toThrow(/scopeKey/);
    expect(() => validateIndexDocument({ ...doc, stamp: { ...doc.stamp, source: { kind: "engine", name: "plunge" } } })).toThrow(/source kind/);
  });
});
