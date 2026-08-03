import { describe, test, expect } from "vitest";
import {
  NOT_ATTEMPTED_REASONS,
  isNotAttemptedReason,
  isApplyResult,
  applyResult,
  normalizeApply,
  notAttemptedAll,
  applyRefKey,
  overlappingRefs,
  unaccountedRefs,
  type ApplyRef,
} from "./apply";

const ref = (kind: string, name: string): ApplyRef => ({ kind, name });

describe("NotAttemptedReason is total (#1446)", () => {
  test("every reason is recognised, and nothing else is", () => {
    for (const r of NOT_ATTEMPTED_REASONS) expect(isNotAttemptedReason(r)).toBe(true);
    expect(isNotAttemptedReason("skipped")).toBe(false);
    expect(isNotAttemptedReason("")).toBe(false);
    expect(isNotAttemptedReason(undefined)).toBe(false);
  });

  // The write-side peer of UnobservedReason. Free-form strings are what let the
  // gcp skip say "no mapper for kind X" to stdout and nothing to the caller.
  test("the prune-side reason exists, because it is a different fact", () => {
    expect(NOT_ATTEMPTED_REASONS).toContain("not-prunable");
    expect(NOT_ATTEMPTED_REASONS).toContain("unsupported-kind");
  });
});

describe("the envelope discriminates itself (#1446)", () => {
  test("isApplyResult recognises the versioned shape only", () => {
    expect(isApplyResult(applyResult([]))).toBe(true);
    expect(isApplyResult({ applied: [], pruned: [] })).toBe(false);
    expect(isApplyResult({ apply: "v2" })).toBe(false);
    expect(isApplyResult(null)).toBe(false);
  });

  test("applyResult omits empty buckets rather than emitting empty arrays", () => {
    expect(applyResult([{ ...ref("Bucket", "a"), action: "created" }])).toEqual({
      apply: "v1",
      applied: [{ kind: "Bucket", name: "a", action: "created" }],
    });
  });
});

describe("normalizeApply (#1446)", () => {
  test("an un-migrated applier's shape means 'everything I was handed, I attempted'", () => {
    // The compatibility path. Nothing is invented on its behalf — an empty
    // notAttempted is exactly the claim that shape implicitly makes.
    const n = normalizeApply({ applied: [{ ...ref("K", "a"), action: "created" }] });
    expect(n.notAttempted).toEqual([]);
    expect(n.pruned).toEqual([]);
    expect(n.applied).toHaveLength(1);
  });

  test("the envelope's notAttempted survives normalization", () => {
    const n = normalizeApply(
      applyResult([], [], [{ ...ref("SQLInstance", "db"), reason: "unsupported-kind" }]),
    );
    expect(n.notAttempted).toEqual([{ kind: "SQLInstance", name: "db", reason: "unsupported-kind" }]);
  });

  // The read side has the same rule for the same reason: returning nothing must
  // not be a way to claim success over work that never happened.
  test("undefined normalizes to empty, so 'I could not' must be said explicitly", () => {
    expect(normalizeApply(undefined)).toEqual({ applied: [], pruned: [], notAttempted: [] });
  });
});

describe("notAttemptedAll (#1446)", () => {
  test("marks a whole plan with one reason, for the run-level failure", () => {
    const out = notAttemptedAll([ref("K", "a"), ref("K", "b")], "no-credentials", "no token");
    expect(out).toEqual([
      { kind: "K", name: "a", reason: "no-credentials", detail: "no token" },
      { kind: "K", name: "b", reason: "no-credentials", detail: "no token" },
    ]);
  });

  test("omits detail when none is given", () => {
    expect(notAttemptedAll([ref("K", "a")], "no-binding")).toEqual([
      { kind: "K", name: "a", reason: "no-binding" },
    ]);
  });
});

describe("the three buckets are disjoint (#1446)", () => {
  test("no overlap is the contract", () => {
    expect(
      overlappingRefs({
        applied: [{ ...ref("K", "a"), action: "created" }],
        pruned: [{ ...ref("K", "b"), deleted: true }],
        notAttempted: [{ ...ref("K", "c"), reason: "unsupported-kind" }],
      }),
    ).toEqual([]);
  });

  // A resource cannot be both written and skipped. An applier reporting that has
  // a bug the return shape would otherwise hide.
  test("the same resource in two buckets is reported", () => {
    expect(
      overlappingRefs({
        applied: [{ ...ref("K", "a"), action: "created" }],
        pruned: [],
        notAttempted: [{ ...ref("K", "a"), reason: "filtered" }],
      }),
    ).toEqual(["K/a"]);
  });

  test("same name, different kind, is not an overlap", () => {
    expect(
      overlappingRefs({
        applied: [{ ...ref("Bucket", "x"), action: "created" }],
        pruned: [{ ...ref("Topic", "x"), deleted: true }],
        notAttempted: [],
      }),
    ).toEqual([]);
  });
});

describe("nothing in the plan is dropped (#1446)", () => {
  // The suite's central assertion, and the one gcp failed before #1447: the
  // unmapped kind was in the plan, in no bucket, and the result looked complete.
  test("a plan entry in no bucket is reported", () => {
    const plan = [ref("Bucket", "mapped"), ref("SQLInstance", "unmapped")];
    const dropped = unaccountedRefs(plan, {
      applied: [{ ...ref("Bucket", "mapped"), action: "created" }],
      pruned: [],
      notAttempted: [],
    });
    expect(dropped).toEqual(["SQLInstance/unmapped"]);
  });

  test("the same plan accounted for in notAttempted passes", () => {
    const plan = [ref("Bucket", "mapped"), ref("SQLInstance", "unmapped")];
    expect(
      unaccountedRefs(plan, {
        applied: [{ ...ref("Bucket", "mapped"), action: "created" }],
        pruned: [],
        notAttempted: [{ ...ref("SQLInstance", "unmapped"), reason: "unsupported-kind" }],
      }),
    ).toEqual([]);
  });

  test("an empty plan is trivially accounted for", () => {
    expect(unaccountedRefs([], { applied: [], pruned: [], notAttempted: [] })).toEqual([]);
  });

  // Prune deletes things the plan does not contain, by definition — so a pruned
  // resource being outside the plan is correct, not a drop.
  test("a pruned resource outside the plan is not a drop", () => {
    expect(
      unaccountedRefs([ref("Bucket", "keep")], {
        applied: [{ ...ref("Bucket", "keep"), action: "unchanged" }],
        pruned: [{ ...ref("Bucket", "orphan"), deleted: true }],
        notAttempted: [],
      }),
    ).toEqual([]);
  });
});

describe("applyRefKey", () => {
  test("separates resources by kind and name", () => {
    expect(applyRefKey(ref("Bucket", "x"))).toBe("Bucket/x");
    expect(applyRefKey(ref("Topic", "x"))).not.toBe(applyRefKey(ref("Bucket", "x")));
  });
});
