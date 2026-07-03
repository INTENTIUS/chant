import { describe, test, expect } from "vitest";
import {
  reconcileStatus,
  liveEvidenceFromChangeSet,
  compareAcrossEnvironments,
  type LiveComponentEvidence,
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
