import { describe, test, expect } from "vitest";
import { diffLive } from "./live-diff";
import type { ResourceMetadata } from "../lexicon";

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
