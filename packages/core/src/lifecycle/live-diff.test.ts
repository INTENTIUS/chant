import { describe, test, expect } from "vitest";
import { diffLive, diffLiveArtifacts } from "./live-diff";
import type { ResourceMetadata, ArtifactMetadata } from "../lexicon";

const meta = (overrides: Partial<ResourceMetadata> = {}): ResourceMetadata => ({
  type: "AWS::S3::Bucket",
  status: "CREATE_COMPLETE",
  physicalId: "bucket-1",
  ...overrides,
});

describe("diffLive", () => {
  test("empty inputs produce empty result", () => {
    const result = diffLive({
      declared: new Set(),
      observedNow: {},
      observedThen: undefined,
    });
    expect(result).toEqual({
      missing: [],
      orphan: [],
      disappeared: [],
      newlyObserved: [],
      driftedSinceSnapshot: [],
      unchanged: [],
    });
  });

  test("declared but not observed → missing", () => {
    const result = diffLive({
      declared: new Set(["bucket"]),
      observedNow: {},
      observedThen: undefined,
    });
    expect(result.missing).toEqual(["bucket"]);
  });

  test("observed but not declared → orphan", () => {
    const result = diffLive({
      declared: new Set(),
      observedNow: { abandoned: meta() },
      observedThen: undefined,
    });
    expect(result.orphan).toEqual(["abandoned"]);
  });

  test("in previous snapshot but not observed now → disappeared", () => {
    const result = diffLive({
      declared: new Set(["bucket"]),
      observedNow: {},
      observedThen: { bucket: meta() },
    });
    expect(result.missing).toEqual(["bucket"]);
    expect(result.disappeared).toEqual(["bucket"]);
  });

  test("observed for the first time (declared, no previous snapshot) → newlyObserved", () => {
    const result = diffLive({
      declared: new Set(["bucket"]),
      observedNow: { bucket: meta() },
      observedThen: {},
    });
    expect(result.newlyObserved).toEqual(["bucket"]);
    expect(result.unchanged).toEqual([]);
    expect(result.driftedSinceSnapshot).toEqual([]);
  });

  test("attribute changed between snapshots → driftedSinceSnapshot with attribute path", () => {
    const result = diffLive({
      declared: new Set(["bucket"]),
      observedNow: { bucket: meta({ status: "UPDATE_COMPLETE", attributes: { tags: { env: "prod" } } }) },
      observedThen: { bucket: meta({ status: "CREATE_COMPLETE", attributes: { tags: { env: "stage" } } }) },
    });
    expect(result.driftedSinceSnapshot).toHaveLength(1);
    const drift = result.driftedSinceSnapshot[0];
    expect(drift.name).toBe("bucket");
    expect(drift.type).toBe("AWS::S3::Bucket");
    const paths = drift.changes.map((c) => c.path).sort();
    expect(paths).toEqual(["attributes.tags", "status"]);
  });

  test("identical metadata between snapshots → unchanged", () => {
    const sameMeta = meta({ attributes: { tags: { env: "prod" } } });
    const result = diffLive({
      declared: new Set(["bucket"]),
      observedNow: { bucket: sameMeta },
      observedThen: { bucket: sameMeta },
    });
    expect(result.unchanged).toEqual(["bucket"]);
    expect(result.driftedSinceSnapshot).toEqual([]);
  });

  test("mixed: counts add up across all six categories", () => {
    const result = diffLive({
      declared: new Set(["a", "b", "c", "d"]),
      observedNow: {
        b: meta(),                                // unchanged
        c: meta({ status: "UPDATE_COMPLETE" }),   // drift
        d: meta(),                                // newlyObserved
        e: meta(),                                // orphan
      },
      observedThen: {
        a: meta(),  // disappeared (and missing, since declared)
        b: meta(),  // unchanged
        c: meta(),  // drift
      },
    });
    expect(result.missing).toEqual(["a"]);
    expect(result.orphan).toEqual(["e"]);
    expect(result.disappeared).toEqual(["a"]);
    expect(result.newlyObserved).toEqual(["d"]);
    expect(result.driftedSinceSnapshot.map((d) => d.name)).toEqual(["c"]);
    expect(result.unchanged).toEqual(["b"]);
  });
});

describe("diffLiveArtifacts", () => {
  const a = (overrides: Partial<ArtifactMetadata> = {}): ArtifactMetadata => ({
    type: "Helm::Release",
    physicalId: "default/foo",
    status: "deployed",
    ...overrides,
  });

  test("empty inputs produce empty result", () => {
    expect(diffLiveArtifacts({ observedNow: {}, observedThen: undefined })).toEqual({
      added: [], removed: [], changed: [], unchanged: [],
    });
  });

  test("observed now, no previous snapshot → added", () => {
    const result = diffLiveArtifacts({
      observedNow: { "release/default/foo": a() },
      observedThen: undefined,
    });
    expect(result.added).toEqual(["release/default/foo"]);
  });

  test("in previous snapshot, gone now → removed", () => {
    const result = diffLiveArtifacts({
      observedNow: {},
      observedThen: { "release/default/foo": a() },
    });
    expect(result.removed).toEqual(["release/default/foo"]);
  });

  test("metadata differs between snapshots → changed", () => {
    const result = diffLiveArtifacts({
      observedNow:  { "release/default/foo": a({ status: "failed" }) },
      observedThen: { "release/default/foo": a({ status: "deployed" }) },
    });
    expect(result.changed).toHaveLength(1);
    expect(result.changed[0].name).toBe("release/default/foo");
    expect(result.changed[0].changes.map((c) => c.path)).toContain("status");
  });

  test("identical metadata → unchanged", () => {
    const same = a();
    const result = diffLiveArtifacts({
      observedNow:  { "release/default/foo": same },
      observedThen: { "release/default/foo": same },
    });
    expect(result.unchanged).toEqual(["release/default/foo"]);
  });

  test("mixed: counts add up across all four categories", () => {
    const result = diffLiveArtifacts({
      observedNow: {
        "release/default/b": a(),                          // unchanged
        "release/default/c": a({ status: "failed" }),      // changed
        "release/default/d": a(),                          // added
      },
      observedThen: {
        "release/default/a": a(),                          // removed
        "release/default/b": a(),                          // unchanged
        "release/default/c": a(),                          // changed
      },
    });
    expect(result.added).toEqual(["release/default/d"]);
    expect(result.removed).toEqual(["release/default/a"]);
    expect(result.changed.map((c) => c.name)).toEqual(["release/default/c"]);
    expect(result.unchanged).toEqual(["release/default/b"]);
  });
});
