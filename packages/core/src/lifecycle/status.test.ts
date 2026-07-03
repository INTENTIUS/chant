import { describe, test, expect } from "vitest";
import {
  reconcileStatus,
  liveEvidenceFromChangeSet,
  resolveLiveNames,
  compareAcrossEnvironments,
  type LiveComponentEvidence,
  type LiveNameMapping,
} from "./status";
import type { ReleaseRecord } from "./release-ledger";
import type { ChangeSet } from "./change-set";
import type { BuildLedgerEntry } from "./build-ledger";

function record(overrides?: Partial<ReleaseRecord>): ReleaseRecord {
  return {
    version: 1,
    component: "search-service",
    env: "prod",
    digest: "sha256:abc",
    gitSha: "deadbeef",
    runId: "run-1",
    timestamp: "2026-01-01T00:00:00.000Z",
    actor: "ci-bot",
    ...overrides,
  };
}

describe("status", () => {
  describe("liveEvidenceFromChangeSet", () => {
    test("projects each change-set entry into live evidence keyed by name", () => {
      const cs: ChangeSet = {
        env: "prod",
        entries: [
          { name: "search-service", type: "T", action: "noop", evidence: { declared: true, inSnapshot: true, live: true }, ownership: "owned" },
          { name: "orphan-thing", type: "T", action: "adopt", evidence: { declared: false, inSnapshot: false, live: true }, ownership: "foreign" },
        ],
      };
      const evidence = liveEvidenceFromChangeSet(cs);
      expect(evidence.get("search-service")).toEqual({ live: true, action: "noop", ownership: "owned" });
      expect(evidence.get("orphan-thing")).toEqual({ live: true, action: "adopt", ownership: "foreign" });
    });

    // #598: a component's name need not equal the live entity/resource name
    // it owns. Callers pass an explicit `nameMapping`; without one (or for a
    // component absent from it), the name == entity join above is unchanged.
    describe("with a nameMapping (#598)", () => {
      test("joins a component to a live entity name that differs from the component name", () => {
        const cs: ChangeSet = {
          env: "prod",
          entries: [
            { name: "search-service-v2", type: "T", action: "noop", evidence: { declared: true, inSnapshot: true, live: true }, ownership: "owned" },
          ],
        };
        const mapping: LiveNameMapping = new Map([["search-svc", ["search-service-v2"]]]);
        const evidence = liveEvidenceFromChangeSet(cs, mapping);
        expect(evidence.get("search-svc")).toEqual({ live: true, action: "noop", ownership: "owned" });
        // The live entity's own name is no longer a separate top-level key once
        // it's claimed by an explicit mapping's component.
      });

      test("a component with no entry in the mapping still resolves by identity", () => {
        const cs: ChangeSet = {
          env: "prod",
          entries: [
            { name: "search-service", type: "T", action: "noop", evidence: { declared: true, inSnapshot: true, live: true }, ownership: "owned" },
          ],
        };
        const mapping: LiveNameMapping = new Map([["some-other-component", ["renamed-thing"]]]);
        const evidence = liveEvidenceFromChangeSet(cs, mapping);
        expect(evidence.get("search-service")).toEqual({ live: true, action: "noop", ownership: "owned" });
      });

      test("aggregates evidence across several live names owned by one component", () => {
        const cs: ChangeSet = {
          env: "prod",
          entries: [
            { name: "cluster-node-1", type: "T", action: "noop", evidence: { declared: true, inSnapshot: true, live: true }, ownership: "owned" },
            { name: "cluster-node-2", type: "T", action: "update", evidence: { declared: true, inSnapshot: true, live: true }, ownership: "owned" },
          ],
        };
        const mapping: LiveNameMapping = new Map([["neo4j-cluster", ["cluster-node-1", "cluster-node-2"]]]);
        const evidence = liveEvidenceFromChangeSet(cs, mapping);
        // Drift on any owned entity surfaces as drift for the component.
        expect(evidence.get("neo4j-cluster")).toEqual({ live: true, action: "update", ownership: "owned" });
      });

      test("a mapped component with none of its live names observed has no evidence entry", () => {
        const cs: ChangeSet = { env: "prod", entries: [] };
        const mapping: LiveNameMapping = new Map([["ghost-component", ["ghost-entity"]]]);
        const evidence = liveEvidenceFromChangeSet(cs, mapping);
        expect(evidence.has("ghost-component")).toBe(false);
      });
    });
  });

  describe("resolveLiveNames (#598)", () => {
    test("falls back to the component's own name when no mapping is given", () => {
      expect(resolveLiveNames("search-service")).toEqual(["search-service"]);
    });

    test("falls back to the component's own name when the mapping has no entry for it", () => {
      const mapping: LiveNameMapping = new Map([["other", ["other-entity"]]]);
      expect(resolveLiveNames("search-service", mapping)).toEqual(["search-service"]);
    });

    test("uses the explicit liveNames when present", () => {
      const mapping: LiveNameMapping = new Map([["search-svc", ["search-service-v2"]]]);
      expect(resolveLiveNames("search-svc", mapping)).toEqual(["search-service-v2"]);
    });
  });

  describe("reconcileStatus", () => {
    test("no liveEvidence at all -> recorded rows are 'unknown', unrecorded stay 'unrecorded'", () => {
      const rows = reconcileStatus("prod", [record()], { allComponents: ["search-service", "other-service"] });
      const search = rows.find((r) => r.component === "search-service")!;
      const other = rows.find((r) => r.component === "other-service")!;
      expect(search.reconciliation).toBe("unknown");
      expect(other.reconciliation).toBe("unrecorded");
    });

    test("recorded + live + owned + no drift -> reconciled", () => {
      const liveEvidence = new Map<string, LiveComponentEvidence>([
        ["search-service", { live: true, action: "noop", ownership: "owned" }],
      ]);
      const rows = reconcileStatus("prod", [record()], { liveEvidence });
      expect(rows[0].reconciliation).toBe("reconciled");
    });

    test("recorded + live action=update -> drifted", () => {
      const liveEvidence = new Map<string, LiveComponentEvidence>([
        ["search-service", { live: true, action: "update", ownership: "owned" }],
      ]);
      const rows = reconcileStatus("prod", [record()], { liveEvidence });
      expect(rows[0].reconciliation).toBe("drifted");
    });

    test("recorded but nothing live -> stale", () => {
      const liveEvidence = new Map<string, LiveComponentEvidence>();
      const rows = reconcileStatus("prod", [record()], { liveEvidence });
      expect(rows[0].reconciliation).toBe("stale");
      expect(rows[0].detail).toContain("nothing observed live");
    });

    test("live and owned but no release record -> unrecorded (the headline case: unrecorded deploy)", () => {
      const liveEvidence = new Map<string, LiveComponentEvidence>([
        ["mystery-service", { live: true, action: "noop", ownership: "owned" }],
      ]);
      const rows = reconcileStatus("prod", [], { liveEvidence, allComponents: ["mystery-service"] });
      expect(rows[0]).toMatchObject({ component: "mystery-service", reconciliation: "unrecorded" });
      expect(rows[0].detail).toContain("chant-owned");
    });

    test("neither recorded nor live -> unrecorded with a distinct detail message", () => {
      const liveEvidence = new Map<string, LiveComponentEvidence>();
      const rows = reconcileStatus("prod", [], { liveEvidence, allComponents: ["ghost-service"] });
      expect(rows[0].reconciliation).toBe("unrecorded");
      expect(rows[0].detail).toContain("no release record and nothing observed live");
    });

    test("attaches build-ledger detail keyed by the recorded digest", () => {
      const build: BuildLedgerEntry = {
        component: "search-service",
        path: "image.tar",
        digest: "sha256:abc",
        createdAt: "2026-01-01T00:00:00.000Z",
        manifestDigest: "sha256:manifest",
        referrers: [{ kind: "sbom", mediaType: "x", digest: "sha256:sbom" }],
      };
      const buildsByDigest = new Map([["sha256:abc", build]]);
      const liveEvidence = new Map<string, LiveComponentEvidence>([
        ["search-service", { live: true, action: "noop", ownership: "owned" }],
      ]);
      const rows = reconcileStatus("prod", [record()], { liveEvidence, buildsByDigest });
      expect(rows[0].build).toEqual(build);
    });

    // #606: the build ledger's `sbom` summary (format/package count/source)
    // flows through to `chant components status` unchanged — `reconcileStatus`
    // treats `BuildLedgerEntry` opaquely, so no reconciliation logic needed to
    // change for the status surface to gain SBOM visibility.
    test("surfaces the build-ledger's sbom summary (format, package count, source) by digest", () => {
      const build: BuildLedgerEntry = {
        component: "search-service",
        path: "image.tar",
        digest: "sha256:abc",
        createdAt: "2026-01-01T00:00:00.000Z",
        manifestDigest: "sha256:manifest",
        referrers: [],
        sbom: { mediaType: "application/spdx+json", packageCount: 12, generator: "syft", source: "archive" },
      };
      const buildsByDigest = new Map([["sha256:abc", build]]);
      const liveEvidence = new Map<string, LiveComponentEvidence>([
        ["search-service", { live: true, action: "noop", ownership: "owned" }],
      ]);
      const rows = reconcileStatus("prod", [record()], { liveEvidence, buildsByDigest });
      expect(rows[0].build?.sbom).toEqual({
        mediaType: "application/spdx+json",
        packageCount: 12,
        generator: "syft",
        source: "archive",
      });
    });

    test("only the latest record per component is used for reconciliation", () => {
      const records = [
        record({ digest: "sha256:old", timestamp: "2026-01-01T00:00:00.000Z" }),
        record({ digest: "sha256:new", timestamp: "2026-01-02T00:00:00.000Z" }),
      ];
      const liveEvidence = new Map<string, LiveComponentEvidence>([
        ["search-service", { live: true, action: "noop", ownership: "owned" }],
      ]);
      const rows = reconcileStatus("prod", records, { liveEvidence });
      expect(rows[0].recorded?.digest).toBe("sha256:new");
    });

    test("rows are sorted by component name", () => {
      const rows = reconcileStatus("prod", [
        record({ component: "zeta" }),
        record({ component: "alpha" }),
      ], { liveEvidence: new Map() });
      expect(rows.map((r) => r.component)).toEqual(["alpha", "zeta"]);
    });

    // #598, end-to-end: a component whose live entity name differs from its
    // component name reconciles correctly once the caller supplies a
    // nameMapping to liveEvidenceFromChangeSet, and the identity default
    // (name == entity) keeps working unchanged for everything else.
    test("a component whose live entity name differs from its own name reconciles via a nameMapping", () => {
      const cs: ChangeSet = {
        env: "prod",
        entries: [
          { name: "search-service-v2", type: "T", action: "noop", evidence: { declared: true, inSnapshot: true, live: true }, ownership: "owned" },
        ],
      };
      const mapping: LiveNameMapping = new Map([["search-svc", ["search-service-v2"]]]);
      const liveEvidence = liveEvidenceFromChangeSet(cs, mapping);

      const rows = reconcileStatus("prod", [record({ component: "search-svc" })], { liveEvidence });
      expect(rows[0]).toMatchObject({ component: "search-svc", reconciliation: "reconciled" });
    });

    test("the name == entity default still works when no mapping is supplied at all", () => {
      const cs: ChangeSet = {
        env: "prod",
        entries: [
          { name: "search-service", type: "T", action: "noop", evidence: { declared: true, inSnapshot: true, live: true }, ownership: "owned" },
        ],
      };
      const liveEvidence = liveEvidenceFromChangeSet(cs);

      const rows = reconcileStatus("prod", [record({ component: "search-service" })], { liveEvidence });
      expect(rows[0]).toMatchObject({ component: "search-service", reconciliation: "reconciled" });
    });
  });

  describe("compareAcrossEnvironments", () => {
    test("same digest in both envs -> same: true", () => {
      const result = compareAcrossEnvironments(
        "search-service",
        { name: "staging", records: [record({ env: "staging", digest: "sha256:shared" })] },
        { name: "prod", records: [record({ env: "prod", digest: "sha256:shared" })] },
      );
      expect(result).toMatchObject({ digestA: "sha256:shared", digestB: "sha256:shared", same: true });
    });

    test("different digests -> same: false", () => {
      const result = compareAcrossEnvironments(
        "search-service",
        { name: "staging", records: [record({ env: "staging", digest: "sha256:staging-build" })] },
        { name: "prod", records: [record({ env: "prod", digest: "sha256:prod-build" })] },
      );
      expect(result.same).toBe(false);
    });

    test("missing record in one env -> same: false, digest undefined for that side", () => {
      const result = compareAcrossEnvironments(
        "search-service",
        { name: "staging", records: [] },
        { name: "prod", records: [record({ env: "prod" })] },
      );
      expect(result.digestA).toBeUndefined();
      expect(result.digestB).toBe("sha256:abc");
      expect(result.same).toBe(false);
    });
  });
});
