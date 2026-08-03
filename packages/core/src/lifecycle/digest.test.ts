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

/**
 * chant #1442 — a digest records what interpreted the declarations, not only
 * what was declared.
 */
function withVersions(versions: Record<string, string> | undefined): BuildResult {
  const result = makeBuildResult({ k8s: [{ name: "app", type: "K8s::Apps::Deployment", props: { replicas: 2 } }] });
  return { ...result, lexiconVersions: versions } as unknown as BuildResult;
}

describe("computeBuildDigest — lexicon versions (#1442)", () => {
  test("records the version of each lexicon that served the build", () => {
    expect(computeBuildDigest(withVersions({ k8s: "0.38.0" })).lexiconVersions).toEqual({ k8s: "0.38.0" });
  });

  test("records once per lexicon, not once per resource", () => {
    const many = makeBuildResult({
      k8s: [
        { name: "a", type: "K8s::Apps::Deployment", props: {} },
        { name: "b", type: "K8s::Core::Service", props: {} },
      ],
    });
    const digest = computeBuildDigest({ ...many, lexiconVersions: { k8s: "0.38.0" } } as unknown as BuildResult);
    expect(Object.keys(digest.resources)).toHaveLength(2);
    expect(digest.lexiconVersions).toEqual({ k8s: "0.38.0" });
  });

  test("a build with no plugins records an empty map, not absence", () => {
    // Absent and empty mean different things when read back: absent is
    // "recorded before #1442", empty is "recorded, nothing loaded".
    expect(computeBuildDigest(withVersions(undefined)).lexiconVersions).toEqual({});
  });

  test("the recorded map is a copy, so later mutation cannot rewrite history", () => {
    const versions = { k8s: "0.38.0" };
    const digest = computeBuildDigest(withVersions(versions));
    versions.k8s = "0.39.0";
    expect(digest.lexiconVersions).toEqual({ k8s: "0.38.0" });
  });
});

describe("diffDigests — lexicon version changes (#1442)", () => {
  const resources = { app: { type: "K8s::Apps::Deployment", lexicon: "k8s", propsHash: "same" } };
  const digest = (lexiconVersions?: Record<string, string>): BuildDigest =>
    ({ resources, dependencies: {}, outputs: {}, deployOrder: ["k8s"], lexiconVersions }) as BuildDigest;

  test("reports a bump even when every resource is unchanged", () => {
    const diff = diffDigests(digest({ k8s: "0.39.0" }), digest({ k8s: "0.38.0" }));
    expect(diff.changed).toEqual([]);
    expect(diff.unchanged).toEqual(["app"]);
    expect(diff.lexiconVersionChanges).toEqual([{ lexicon: "k8s", previous: "0.38.0", current: "0.39.0" }]);
  });

  test("reports nothing when versions match", () => {
    expect(diffDigests(digest({ k8s: "0.38.0" }), digest({ k8s: "0.38.0" })).lexiconVersionChanges).toEqual([]);
  });

  test("reports a lexicon added to or dropped from the build", () => {
    const added = diffDigests(digest({ k8s: "0.38.0", aws: "0.38.0" }), digest({ k8s: "0.38.0" }));
    expect(added.lexiconVersionChanges).toEqual([{ lexicon: "aws", previous: undefined, current: "0.38.0" }]);

    const dropped = diffDigests(digest({ k8s: "0.38.0" }), digest({ k8s: "0.38.0", aws: "0.38.0" }));
    expect(dropped.lexiconVersionChanges).toEqual([{ lexicon: "aws", previous: "0.38.0", current: undefined }]);
  });

  test("a pre-#1442 snapshot reports no change rather than inventing one", () => {
    // The older digest never recorded versions. Every lexicon would otherwise
    // look newly-added on the first comparison after upgrading chant.
    expect(diffDigests(digest({ k8s: "0.38.0" }), digest(undefined)).lexiconVersionChanges).toEqual([]);
    expect(diffDigests(digest(undefined), digest({ k8s: "0.38.0" })).lexiconVersionChanges).toEqual([]);
  });

  test("with no previous digest at all, there is no version change", () => {
    expect(diffDigests(digest({ k8s: "0.38.0" }), undefined).lexiconVersionChanges).toEqual([]);
  });

  test("changes are ordered by lexicon name, so output is stable", () => {
    const diff = diffDigests(digest({ k8s: "2", aws: "2", gcp: "2" }), digest({ k8s: "1", aws: "1", gcp: "1" }));
    expect(diff.lexiconVersionChanges.map((c) => c.lexicon)).toEqual(["aws", "gcp", "k8s"]);
  });
});
