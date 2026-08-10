import { describe, test, expect } from "vitest";
import { diffLive, diffLiveArtifacts, diffSnapshots } from "./live-diff";
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
      runtimeChildren: [],
      disappeared: [],
      newlyObserved: [],
      driftedSinceSnapshot: [],
      unchanged: [],
      unobserved: [],
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

  // ── Owner-reference chain classification (#1077) ──────────────────────────

  describe("runtime children vs orphans", () => {
    test("undeclared, chain reaches a declared entity → runtimeChildren, never orphan", () => {
      const result = diffLive({
        declared: new Set(["web"]),
        observedNow: {
          web: meta({ type: "K8s::Apps::Deployment" }),
          "prod/web-abc123": meta({ type: "K8s::Core::Pod", ownerChain: { root: "declared", entity: "web" } }),
        },
        observedThen: undefined,
      });
      expect(result.orphan).toEqual([]);
      expect(result.runtimeChildren).toEqual([
        { name: "prod/web-abc123", type: "K8s::Core::Pod", owner: "web" },
      ]);
    });

    test("undeclared, no owner reference at all → orphan", () => {
      const result = diffLive({
        declared: new Set(),
        observedNow: { "prod/standalone": meta({ ownerChain: { root: "unowned" } }) },
        observedThen: undefined,
      });
      expect(result.orphan).toEqual(["prod/standalone"]);
      expect(result.runtimeChildren).toEqual([]);
    });

    test("undeclared, chain resolves to a foreign (non-declared) root → orphan", () => {
      const result = diffLive({
        declared: new Set(),
        observedNow: { "prod/other-app-pod": meta({ ownerChain: { root: "foreign" } }) },
        observedThen: undefined,
      });
      expect(result.orphan).toEqual(["prod/other-app-pod"]);
      expect(result.runtimeChildren).toEqual([]);
    });

    test("undeclared, chain could not be resolved (unreadable owner/cycle/depth) → conservative orphan, not runtime", () => {
      const result = diffLive({
        declared: new Set(),
        observedNow: { "prod/mystery-pod": meta({ ownerChain: { root: "unknown" } }) },
        observedThen: undefined,
      });
      expect(result.orphan).toEqual(["prod/mystery-pod"]);
      expect(result.runtimeChildren).toEqual([]);
    });

    test("a lexicon that never sets ownerChain is unaffected — undeclared stays orphan", () => {
      const result = diffLive({
        declared: new Set(),
        observedNow: { legacy: meta() }, // no ownerChain at all
        observedThen: undefined,
      });
      expect(result.orphan).toEqual(["legacy"]);
      expect(result.runtimeChildren).toEqual([]);
    });

    test("a runtime child rolling to a new name between snapshots is not `disappeared`", () => {
      const result = diffLive({
        declared: new Set(["web"]),
        observedNow: {
          web: meta({ type: "K8s::Apps::Deployment" }),
          "prod/web-newname": meta({ type: "K8s::Core::Pod", ownerChain: { root: "declared", entity: "web" } }),
        },
        observedThen: { "prod/web-oldname": meta({ type: "K8s::Core::Pod", ownerChain: { root: "declared", entity: "web" } }) },
      });
      expect(result.disappeared).toEqual([]);
      expect(result.runtimeChildren).toEqual([
        { name: "prod/web-newname", type: "K8s::Core::Pod", owner: "web" },
      ]);
    });

    test("a runtime child's own status change between snapshots is not driftedSinceSnapshot", () => {
      const podThen = meta({ type: "K8s::Core::Pod", status: "PROGRESSING", ownerChain: { root: "declared", entity: "web" } });
      const podNow = meta({ type: "K8s::Core::Pod", status: "READY", ownerChain: { root: "declared", entity: "web" } });
      const result = diffLive({
        declared: new Set(["web"]),
        observedNow: { web: meta({ type: "K8s::Apps::Deployment" }), "prod/web-stable-0": podNow },
        observedThen: { "prod/web-stable-0": podThen },
      });
      expect(result.driftedSinceSnapshot).toEqual([]);
      expect(result.unchanged).not.toContain("prod/web-stable-0");
      expect(result.runtimeChildren.map((r) => r.name)).toEqual(["prod/web-stable-0"]);
    });
  });

  // ── The observation tri-state (#1089) ─────────────────────────────────────

  test("declared and not observed → unobserved, not missing", () => {
    const result = diffLive({
      declared: new Set(["crd", "gone"]),
      observedNow: {},
      observedThen: undefined,
      unobserved: { crd: { type: "K8s::X::Widget", reason: "unsupported-kind", detail: "no reader" } },
    });
    expect(result.missing).toEqual(["gone"]);
    expect(result.unobserved).toEqual([
      { name: "crd", type: "K8s::X::Widget", reason: "unsupported-kind", detail: "no reader" },
    ]);
  });

  test("an unobserved entity in the last snapshot has not disappeared", () => {
    const result = diffLive({
      declared: new Set(["crd"]),
      observedNow: {},
      observedThen: { crd: meta() },
      unobserved: { crd: { reason: "no-credentials" } },
    });
    expect(result.disappeared).toEqual([]);
    expect(result.missing).toEqual([]);
    expect(result.unobserved.map((u) => u.name)).toEqual(["crd"]);
  });

  test("the queried addresses pass through, and a missing entity's address is readable off the result (#1620)", () => {
    const result = diffLive({
      declared: new Set(["web"]),
      observedNow: {},
      observedThen: undefined,
      queried: { web: "/apis/apps/v1/namespaces/default/deployments/web" },
    });
    // The verdict itself does not move: still a confirmed absence.
    expect(result.missing).toEqual(["web"]);
    // But the row can explain itself — behold renders `queried: <path> → 404`.
    expect(result.queried).toEqual({ web: "/apis/apps/v1/namespaces/default/deployments/web" });
  });

  test("no queried input → no queried key on the result — other lexicons omitting it stays valid (#1620)", () => {
    const result = diffLive({ declared: new Set(["web"]), observedNow: {}, observedThen: undefined });
    expect("queried" in result).toBe(false);
  });

  test("an unobserved row carries the address of the failed read, from the entry or the map (#1620)", () => {
    const result = diffLive({
      declared: new Set(["a", "b"]),
      observedNow: {},
      observedThen: undefined,
      unobserved: {
        a: { reason: "read-failed", detail: "HTTP 500", queried: "/api/v1/namespaces/default/services/a" },
        b: { reason: "no-credentials" },
      },
      queried: { b: "/api/v1/namespaces/default/services/b" },
    });
    expect(result.unobserved).toEqual([
      { name: "a", reason: "read-failed", detail: "HTTP 500", queried: "/api/v1/namespaces/default/services/a" },
      { name: "b", reason: "no-credentials", queried: "/api/v1/namespaces/default/services/b" },
    ]);
  });

  test("a resource that was returned is never also unobserved", () => {
    const result = diffLive({
      declared: new Set(["a"]),
      observedNow: { a: meta() },
      observedThen: undefined,
      unobserved: { a: { reason: "read-failed" } },
    });
    expect(result.unobserved).toEqual([]);
    expect(result.newlyObserved).toEqual(["a"]);
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

describe("diffSnapshots (#822)", () => {
  test("classifies added / removed / changed / unchanged between two snapshots", () => {
    const prev = {
      vpc: meta({ physicalId: "vpc-1" }),
      subnet: meta({ physicalId: "subnet-1", status: "CREATE_COMPLETE" }),
      gone: meta({ physicalId: "old" }),
    };
    const next = {
      vpc: meta({ physicalId: "vpc-1" }), // unchanged
      subnet: meta({ physicalId: "subnet-1", status: "UPDATE_COMPLETE" }), // changed (status)
      fresh: meta({ physicalId: "new" }), // added
    };
    const d = diffSnapshots(prev, next);
    expect(d.added).toEqual(["fresh"]);
    expect(d.removed).toEqual(["gone"]);
    expect(d.unchanged).toEqual(["vpc"]);
    expect(d.changed.map((c) => c.name)).toEqual(["subnet"]);
    expect(d.changed[0].changes.map((c) => c.path)).toContain("status");
  });

  test("empty vs empty is all-unchanged-empty; results are sorted", () => {
    expect(diffSnapshots({}, {})).toEqual({ added: [], removed: [], changed: [], unchanged: [] });
    const d = diffSnapshots({}, { b: meta(), a: meta() });
    expect(d.added).toEqual(["a", "b"]);
  });
});

describe("attribute comparison is key-order insensitive (#1279)", () => {
  const inst = (attributes: Record<string, unknown>): ResourceMetadata => ({
    type: "AWS::EC2::Instance",
    status: "OBSERVED",
    physicalId: "i-1",
    attributes,
  });

  test("does not drift when a provider reorders the keys of a nested object", () => {
    // Exactly what AWS did between two reads of the same untouched instance.
    const result = diffLive({
      declared: new Set(["one"]),
      observedNow: { one: inst({ Placement: { Tenancy: "default", AvailabilityZone: "us-east-1c" } }) },
      observedThen: { one: inst({ Placement: { AvailabilityZone: "us-east-1c", Tenancy: "default" } }) },
    });
    expect(result.driftedSinceSnapshot).toEqual([]);
    expect(result.unchanged).toEqual(["one"]);
  });

  test("still reports a real change to a nested value", () => {
    const result = diffLive({
      declared: new Set(["one"]),
      observedNow: { one: inst({ Placement: { AvailabilityZone: "us-east-1d" } }) },
      observedThen: { one: inst({ Placement: { AvailabilityZone: "us-east-1c" } }) },
    });
    expect(result.driftedSinceSnapshot.map((d) => d.changes[0].path)).toEqual(["attributes.Placement"]);
  });

  test("keeps array order significant — for a list, order is part of the value", () => {
    const result = diffLive({
      declared: new Set(["one"]),
      observedNow: { one: inst({ Rules: [{ p: 80 }, { p: 22 }] }) },
      observedThen: { one: inst({ Rules: [{ p: 22 }, { p: 80 }] }) },
    });
    expect(result.driftedSinceSnapshot).toHaveLength(1);
  });
});
