import { describe, test, expect } from "vitest";
import { computeBuildDigest, diffDigests, hashProps } from "./digest";
import type { BuildResult } from "../build";
import type { BuildDigest } from "./types";

function makeBuildResult(entitiesByLexicon: Record<string, Array<{ name: string; type: string; props: unknown }>>): BuildResult {
  const entities = new Map();
  for (const [lexicon, list] of Object.entries(entitiesByLexicon)) {
    for (const item of list) {
      entities.set(item.name, { lexicon, entityType: item.type, props: item.props });
    }
  }
  return {
    outputs: new Map(Object.keys(entitiesByLexicon).map((l) => [l, "{}"])),
    entities,
    dependencies: new Map(),
    errors: [],
    warnings: [],
    manifest: {
      lexicons: Object.keys(entitiesByLexicon),
      outputs: {},
      deployOrder: Object.keys(entitiesByLexicon),
    },
    sourceFileCount: 1,
  } as unknown as BuildResult;
}

describe("hashProps", () => {
  test("produces the same hash for identical props", () => {
    expect(hashProps({ a: 1, b: 2 })).toBe(hashProps({ a: 1, b: 2 }));
  });

  test("is order-independent (sorted JSON serialization)", () => {
    expect(hashProps({ a: 1, b: 2 })).toBe(hashProps({ b: 2, a: 1 }));
  });

  test("produces different hashes for different props", () => {
    expect(hashProps({ a: 1 })).not.toBe(hashProps({ a: 2 }));
  });
});

describe("computeBuildDigest", () => {
  test("emits one entry per entity with type, lexicon, and propsHash", () => {
    const buildResult = makeBuildResult({
      aws: [{ name: "bucket", type: "AWS::S3::Bucket", props: { name: "data" } }],
    });
    const digest = computeBuildDigest(buildResult);
    expect(digest.resources["bucket"]).toMatchObject({
      type: "AWS::S3::Bucket",
      lexicon: "aws",
      propsHash: expect.any(String),
    });
  });

  test("missing props default to empty object", () => {
    const buildResult = makeBuildResult({ aws: [{ name: "x", type: "T", props: undefined }] });
    const digest = computeBuildDigest(buildResult);
    expect(digest.resources["x"].propsHash).toBe(hashProps({}));
  });

  test("mirrors the build manifest's deployOrder and outputs", () => {
    const buildResult = makeBuildResult({
      aws: [{ name: "b", type: "T", props: {} }],
      gcp: [{ name: "g", type: "T", props: {} }],
    });
    const digest = computeBuildDigest(buildResult);
    expect(digest.deployOrder).toEqual(["aws", "gcp"]);
    expect(digest.outputs).toEqual({});
  });
});

describe("diffDigests", () => {
  function makeDigest(resources: Record<string, string>): BuildDigest {
    const out: BuildDigest["resources"] = {};
    for (const [name, propsHash] of Object.entries(resources)) {
      out[name] = { type: "T", lexicon: "aws", propsHash };
    }
    return { resources: out, dependencies: {}, outputs: {}, deployOrder: [] };
  }

  test("no previous digest → everything is added", () => {
    const result = diffDigests(makeDigest({ a: "x", b: "y" }), undefined);
    expect(result.added).toEqual(["a", "b"]);
    expect(result.removed).toEqual([]);
    expect(result.changed).toEqual([]);
    expect(result.unchanged).toEqual([]);
  });

  test("identical digests → all unchanged", () => {
    const d = makeDigest({ a: "x" });
    const result = diffDigests(d, d);
    expect(result.unchanged).toEqual(["a"]);
    expect(result.added).toEqual([]);
    expect(result.changed).toEqual([]);
    expect(result.removed).toEqual([]);
  });

  test("different propsHash → changed", () => {
    const result = diffDigests(makeDigest({ a: "x2" }), makeDigest({ a: "x1" }));
    expect(result.changed).toEqual(["a"]);
  });

  test("resource gone from current → removed", () => {
    const result = diffDigests(makeDigest({}), makeDigest({ a: "x" }));
    expect(result.removed).toEqual(["a"]);
  });

  test("mixed: added + removed + changed + unchanged", () => {
    const previous = makeDigest({ a: "x1", b: "y", c: "z" });
    const current = makeDigest({ a: "x2", b: "y", d: "w" });
    const result = diffDigests(current, previous);
    expect(result.added.sort()).toEqual(["d"]);
    expect(result.changed.sort()).toEqual(["a"]);
    expect(result.unchanged.sort()).toEqual(["b"]);
    expect(result.removed.sort()).toEqual(["c"]);
  });
});
