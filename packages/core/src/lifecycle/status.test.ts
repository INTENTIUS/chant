import { describe, test, expect } from "vitest";
import {
  reconcileStatus,
  liveEvidenceFromChangeSet,
  resolveLiveNames,
  compareAcrossEnvironments,
  mergeLiveEvidence,
  type LiveComponentEvidence,
  type LiveNameMapping,
} from "./status";
import type { ReleaseRecord } from "./release-ledger";
import type { ChangeSet } from "./change-set";
import type { BuildLedgerEntry, ComponentBomSummary } from "./build-ledger";

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
          { name: "search-service", type: "T", action: "noop", evidence: { declared: true, inSnapshot: true, live: true, observed: true }, ownership: "owned" },
          { name: "orphan-thing", type: "T", action: "adopt", evidence: { declared: false, inSnapshot: false, live: true, observed: true }, ownership: "foreign" },
        ],
      };
      const evidence = liveEvidenceFromChangeSet(cs);
      expect(evidence.get("search-service")).toEqual({
          live: true,
          action: "noop",
          ownership: "owned",
          rollup: { total: 1, present: 1, absent: 0, unobserved: 0 },
        });
      expect(evidence.get("orphan-thing")).toEqual({
        live: true,
        action: "adopt",
        ownership: "foreign",
        rollup: { total: 1, present: 1, absent: 0, unobserved: 0 },
      });
    });

    // #598: a component's name need not equal the live entity/resource name
    // it owns. Callers pass an explicit `nameMapping`; without one (or for a
    // component absent from it), the name == entity join above is unchanged.
    describe("with a nameMapping (#598)", () => {
      test("joins a component to a live entity name that differs from the component name", () => {
        const cs: ChangeSet = {
          env: "prod",
          entries: [
            { name: "search-service-v2", type: "T", action: "noop", evidence: { declared: true, inSnapshot: true, live: true, observed: true }, ownership: "owned" },
          ],
        };
        const mapping: LiveNameMapping = new Map([["search-svc", ["search-service-v2"]]]);
        const evidence = liveEvidenceFromChangeSet(cs, mapping);
        // The merged verdict, plus the per-resource counts it collapsed
        // (behold#98) — a consumer with no deploy object to read paints from
        // those rather than from a CloudFormation stack.
        expect(evidence.get("search-svc")).toEqual({
          live: true,
          action: "noop",
          ownership: "owned",
          rollup: { total: 1, present: 1, absent: 0, unobserved: 0 },
        });
        // The live entity's own name is no longer a separate top-level key once
        // it's claimed by an explicit mapping's component.
      });

      test("a component with no entry in the mapping still resolves by identity", () => {
        const cs: ChangeSet = {
          env: "prod",
          entries: [
            { name: "search-service", type: "T", action: "noop", evidence: { declared: true, inSnapshot: true, live: true, observed: true }, ownership: "owned" },
          ],
        };
        const mapping: LiveNameMapping = new Map([["some-other-component", ["renamed-thing"]]]);
        const evidence = liveEvidenceFromChangeSet(cs, mapping);
        // A rollup of one: the identity join still reports the shape, so a
        // consumer never branches on whether a mapping was configured.
        expect(evidence.get("search-service")).toEqual({
          live: true,
          action: "noop",
          ownership: "owned",
          rollup: { total: 1, present: 1, absent: 0, unobserved: 0 },
        });
      });

      test("aggregates evidence across several live names owned by one component", () => {
        const cs: ChangeSet = {
          env: "prod",
          entries: [
            { name: "cluster-node-1", type: "T", action: "noop", evidence: { declared: true, inSnapshot: true, live: true, observed: true }, ownership: "owned" },
            { name: "cluster-node-2", type: "T", action: "update", evidence: { declared: true, inSnapshot: true, live: true, observed: true }, ownership: "owned" },
          ],
        };
        const mapping: LiveNameMapping = new Map([["neo4j-cluster", ["cluster-node-1", "cluster-node-2"]]]);
        const evidence = liveEvidenceFromChangeSet(cs, mapping);
        // Drift on any owned entity surfaces as drift for the component.
        expect(evidence.get("neo4j-cluster")).toEqual({
          live: true,
          action: "update",
          ownership: "owned",
          rollup: { total: 2, present: 2, absent: 0, unobserved: 0 },
        });
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

    // behold#98 — floci-az and floci-gcp have no deploy object, so `stack` is
    // absent and a renderer has nothing provider-native to colour from. The
    // rollup is the substrate-neutral source for the same job.
    test("surfaces a resource rollup for a component with no deploy object", () => {
      const liveEvidence = new Map<string, LiveComponentEvidence>([
        [
          "search-service",
          { live: true, ownership: "owned", rollup: { total: 4, present: 3, absent: 0, unobserved: 1 } },
        ],
      ]);
      const rows = reconcileStatus("prod", [record()], { liveEvidence });
      expect(rows[0].resources).toEqual({ total: 4, present: 3, absent: 0, unobserved: 1 });
      // No CloudFormation stack to enrich from, and the row is still paintable.
      expect(rows[0].stack).toBeUndefined();
    });

    test("a rollup and a stack coexist — the stack stays the richer enrichment where it exists", () => {
      const liveEvidence = new Map<string, LiveComponentEvidence>([
        [
          "search-service",
          {
            live: true,
            ownership: "owned",
            stack: { name: "app-prod-search", status: "CREATE_COMPLETE", healthy: true },
            rollup: { total: 2, present: 2, absent: 0, unobserved: 0 },
          },
        ],
      ]);
      const rows = reconcileStatus("prod", [record()], { liveEvidence });
      expect(rows[0].resources).toEqual({ total: 2, present: 2, absent: 0, unobserved: 0 });
      expect(rows[0].stack?.healthy).toBe(true);
    });

    test("surfaces machine-readable live + stack status when observed (#57 hardening)", () => {
      const liveEvidence = new Map<string, LiveComponentEvidence>([
        ["search-service", { live: true, ownership: "owned", stack: { name: "app-prod-search", status: "CREATE_COMPLETE", healthy: true } }],
      ]);
      const rows = reconcileStatus("prod", [record()], { liveEvidence });
      expect(rows[0].live).toBe(true);
      expect(rows[0].stack).toEqual({ name: "app-prod-search", status: "CREATE_COMPLETE", healthy: true });
    });

    test("live is false (never undefined) under --live when a component's stack is absent", () => {
      const liveEvidence = new Map<string, LiveComponentEvidence>([
        ["search-service", { live: false }],
      ]);
      const rows = reconcileStatus("prod", [record()], { liveEvidence });
      expect(rows[0].live).toBe(false);
    });

    test("live is absent (not queried) when no liveEvidence is passed", () => {
      const rows = reconcileStatus("prod", [record()]);
      expect(rows[0].live).toBeUndefined();
      expect(rows[0].stack).toBeUndefined();
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

    // #614: component-level BOM aggregation summary, keyed by digest — the
    // same join key as `buildsByDigest`, but independent of it (a
    // config-only/infra component with no image entry still has a component
    // BOM to report, even though it has no `BuildLedgerEntry` at all).
    test("attaches the component BOM summary keyed by the recorded digest (#614)", () => {
      const componentBom: ComponentBomSummary = {
        leaves: [
          { path: "image.tar.sbom.json", bomKind: "software", subjectDigest: "sha256:img1", mediaType: "application/spdx+json", packageCount: 17, generator: "syft" },
          { path: "search.template.json.config-bom.json", bomKind: "config", subjectDigest: "sha256:tmpl1", mediaType: "application/spdx+json", packageCount: 5 },
        ],
        totalPackageCount: 22,
        isAssembly: true,
      };
      const componentBomByDigest = new Map([["sha256:abc", componentBom]]);
      const liveEvidence = new Map<string, LiveComponentEvidence>([
        ["search-service", { live: true, action: "noop", ownership: "owned" }],
      ]);
      const rows = reconcileStatus("prod", [record()], { liveEvidence, componentBomByDigest });
      expect(rows[0].componentBom).toEqual(componentBom);
    });

    test("componentBom is undefined when no summary is keyed to the recorded digest", () => {
      const liveEvidence = new Map<string, LiveComponentEvidence>([
        ["search-service", { live: true, action: "noop", ownership: "owned" }],
      ]);
      const rows = reconcileStatus("prod", [record()], { liveEvidence, componentBomByDigest: new Map() });
      expect(rows[0].componentBom).toBeUndefined();
    });

    test("componentBom and build are independent — a componentBomByDigest hit with no matching buildsByDigest entry still surfaces the BOM summary", () => {
      const componentBom: ComponentBomSummary = {
        leaves: [{ path: "t.json.config-bom.json", bomKind: "config", mediaType: "application/spdx+json", packageCount: 3 }],
        totalPackageCount: 3,
        isAssembly: false,
      };
      const componentBomByDigest = new Map([["sha256:abc", componentBom]]);
      const liveEvidence = new Map<string, LiveComponentEvidence>([
        ["search-service", { live: true, action: "noop", ownership: "owned" }],
      ]);
      const rows = reconcileStatus("prod", [record()], { liveEvidence, componentBomByDigest });
      expect(rows[0].build).toBeUndefined();
      expect(rows[0].componentBom).toEqual(componentBom);
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
          { name: "search-service-v2", type: "T", action: "noop", evidence: { declared: true, inSnapshot: true, live: true, observed: true }, ownership: "owned" },
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
          { name: "search-service", type: "T", action: "noop", evidence: { declared: true, inSnapshot: true, live: true, observed: true }, ownership: "owned" },
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

    test("pinned helm records compare on inputDigest — per-cluster bytes legitimately differ (ReleaseRecord.inputDigest's own contract)", () => {
      // Same chart+values rendered against two clusters' capability profiles:
      // contentDigests (recorded as `digest`) differ, inputDigests match —
      // prod IS running what staging tested.
      const result = compareAcrossEnvironments(
        "web",
        { name: "staging", records: [record({ component: "web", env: "staging", digest: "sha256:staging-bytes", inputDigest: "sha256:inputs" })] },
        { name: "prod", records: [record({ component: "web", env: "prod", digest: "sha256:prod-bytes", inputDigest: "sha256:inputs" })] },
      );
      expect(result.same).toBe(true);
      expect(result.comparedOn).toEqual({ a: "sha256:inputs", b: "sha256:inputs" });
      // The exact bytes each cluster got stay visible.
      expect(result.digestA).toBe("sha256:staging-bytes");
      expect(result.digestB).toBe("sha256:prod-bytes");
    });

    test("differing inputDigests are a real difference, whatever the bytes say", () => {
      const result = compareAcrossEnvironments(
        "web",
        { name: "staging", records: [record({ component: "web", env: "staging", digest: "sha256:same-bytes", inputDigest: "sha256:inputs-v2" })] },
        { name: "prod", records: [record({ component: "web", env: "prod", digest: "sha256:same-bytes", inputDigest: "sha256:inputs-v1" })] },
      );
      expect(result.same).toBe(false);
    });

    test("one side input-identified, the other content-identified: compared honestly on what each carries", () => {
      // Mixed deploys (a pinned helm release in prod, an unpinned one in
      // staging where the record's digest IS the input digest): staging's
      // digest against prod's inputDigest is the only meaningful join.
      const result = compareAcrossEnvironments(
        "web",
        { name: "staging", records: [record({ component: "web", env: "staging", digest: "sha256:inputs" })] },
        { name: "prod", records: [record({ component: "web", env: "prod", digest: "sha256:prod-bytes", inputDigest: "sha256:inputs" })] },
      );
      expect(result.same).toBe(true);
      expect(result.comparedOn).toEqual({ a: "sha256:inputs", b: "sha256:inputs" });
    });
  });

  describe("mergeLiveEvidence (#57 — per-component stack presence overlay)", () => {
    test("stack presence overrides change-set 'not live' but keeps its drift action", () => {
      const base = new Map<string, LiveComponentEvidence>([
        ["shared-foundation", { live: false }], // entity-keyed observe saw nothing
        ["loom-backend", { live: true, action: "update", ownership: "owned" }],
      ]);
      const supplement = new Map<string, LiveComponentEvidence>([
        ["shared-foundation", { live: true, ownership: "owned" }], // its stack IS present
        ["loom-backend", { live: true, ownership: "owned" }],
      ]);
      const merged = mergeLiveEvidence(base, supplement);
      expect(merged.get("shared-foundation")).toEqual({ live: true, ownership: "owned", action: undefined });
      // loom-backend: presence confirmed, change-set drift action preserved.
      expect(merged.get("loom-backend")).toEqual({ live: true, ownership: "owned", action: "update" });
    });

    test("a component only in the supplement is added; base-only entries pass through", () => {
      const base = new Map<string, LiveComponentEvidence>([["only-base", { live: true, ownership: "foreign" }]]);
      const supplement = new Map<string, LiveComponentEvidence>([["only-sup", { live: false }]]);
      const merged = mergeLiveEvidence(base, supplement);
      expect(merged.get("only-base")).toEqual({ live: true, ownership: "foreign" });
      expect(merged.get("only-sup")).toEqual({ live: false, ownership: undefined, action: undefined });
    });

    test("undefined base (no --live change-set) still yields the supplement", () => {
      const supplement = new Map<string, LiveComponentEvidence>([["c", { live: true, ownership: "owned" }]]);
      const merged = mergeLiveEvidence(undefined, supplement);
      expect(merged.get("c")).toEqual({ live: true, ownership: "owned", action: undefined });
    });

    test("a direct stack observation clears an inherited hole; a failing one keeps it (#1089)", () => {
      const base = new Map<string, LiveComponentEvidence>([
        ["a", { live: false, unobserved: { reason: "read-failed" } }],
        ["b", { live: false, unobserved: { reason: "read-failed" } }],
      ]);
      const supplement = new Map<string, LiveComponentEvidence>([
        ["a", { live: true, ownership: "owned" }],
        ["b", { live: false, unobserved: { reason: "read-failed", detail: "no determinate status" } }],
      ]);
      const merged = mergeLiveEvidence(base, supplement);
      expect(merged.get("a")!.unobserved).toBeUndefined();
      expect(merged.get("b")!.unobserved?.reason).toBe("read-failed");
    });

    test("the change-set rollup survives the stack overlay (behold#100)", () => {
      // The merge rebuilds the evidence object field by field, so a field it
      // does not name is dropped. `describeStackStatus` reports a stack, not
      // per-resource counts, so the supplement never carries a rollup — and
      // dropping the base's meant AWS, the only substrate with a stack
      // observer, was the one substrate whose rows lost the #1300 counts.
      const rollup = { total: 10, present: 10, absent: 0, unobserved: 0 };
      const base = new Map<string, LiveComponentEvidence>([["cc-canonical", { live: true, ownership: "owned", rollup }]]);
      const supplement = new Map<string, LiveComponentEvidence>([
        ["cc-canonical", { live: true, ownership: "owned", stack: { name: "cc-canonical", status: "CREATE_COMPLETE", healthy: true } }],
      ]);
      const merged = mergeLiveEvidence(base, supplement);
      expect(merged.get("cc-canonical")!.rollup).toEqual(rollup);
      expect(merged.get("cc-canonical")!.stack?.status).toBe("CREATE_COMPLETE");
    });

    test("no rollup on either side leaves the field absent rather than undefined", () => {
      const base = new Map<string, LiveComponentEvidence>([["c", { live: true }]]);
      const supplement = new Map<string, LiveComponentEvidence>([["c", { live: true, ownership: "owned" }]]);
      expect(mergeLiveEvidence(base, supplement).get("c")).not.toHaveProperty("rollup");
    });
  });

  // ── The observation tri-state reaches the status join (#1089) ─────────────

  describe("not-observed never becomes 'stale' (#1089)", () => {
    const record = {
      version: 1,
      component: "search-svc",
      env: "prod",
      digest: "sha256:abc",
      gitSha: "g",
      runId: "r",
      timestamp: "2026-01-01T00:00:00Z",
      actor: "ci",
    } as const;

    test("a recorded component whose live state could not be read reports unknown", () => {
      const rows = reconcileStatus("prod", [record], {
        liveEvidence: new Map<string, LiveComponentEvidence>([
          ["search-svc", { live: false, unobserved: { reason: "no-binding", detail: "no kubectl context" } }],
        ]),
      });
      expect(rows[0].reconciliation).toBe("unknown");
      expect(rows[0].detail).toContain("could not be observed");
      expect(rows[0].detail).toContain("no kubectl context");
      // `live` is omitted entirely — `false` would read as "not deployed".
      expect(rows[0].live).toBeUndefined();
      expect(rows[0].unobserved).toEqual({ reason: "no-binding", detail: "no kubectl context" });
    });

    test("the same component, actually observed absent, still reports stale", () => {
      const rows = reconcileStatus("prod", [record], {
        liveEvidence: new Map<string, LiveComponentEvidence>([["search-svc", { live: false }]]),
      });
      expect(rows[0].reconciliation).toBe("stale");
      expect(rows[0].live).toBe(false);
    });

    test("an unrecorded component that could not be read is unknown, not unrecorded", () => {
      const rows = reconcileStatus("prod", [], {
        allComponents: ["search-svc"],
        liveEvidence: new Map<string, LiveComponentEvidence>([
          ["search-svc", { live: false, unobserved: { reason: "read-failed" } }],
        ]),
      });
      expect(rows[0].reconciliation).toBe("unknown");
    });

    test("liveEvidenceFromChangeSet carries the plan's unobserved verdict", () => {
      const evidence = liveEvidenceFromChangeSet({
        env: "prod",
        entries: [
          {
            name: "search-svc",
            action: "unobserved",
            evidence: { declared: true, inSnapshot: false, live: false, observed: false },
            ownership: "unknown",
            unobservedReason: "unsupported-kind",
            unobservedDetail: "no reader",
          },
        ],
      });
      expect(evidence.get("search-svc")!.unobserved).toEqual({
        reason: "unsupported-kind",
        detail: "no reader",
      });
    });
  });
});

describe("partial unit presence is said, not rounded down to nothing (#1528)", () => {
  // The lie this fixes, verbatim from a real estate: a three-unit component
  // (CRDs by kubectl-apply, two Helm releases) whose one absent unit produced
  // `detail: "no release record and nothing observed live"` in the same row
  // whose `stack` field showed a deployed, healthy release.
  const partial = { present: 2, total: 3, missing: ["kmv-crds"] };

  test("unrecorded + partial names the split and the missing units", () => {
    const liveEvidence = new Map<string, LiveComponentEvidence>([
      ["operator", { live: false, partial, stack: { name: "cert-manager", status: "deployed", healthy: true } }],
    ]);
    const rows = reconcileStatus("prod", [], { liveEvidence, allComponents: ["operator"] });
    expect(rows[0].reconciliation).toBe("unrecorded");
    expect(rows[0].detail).toContain("2 of 3 deploy units observed live");
    expect(rows[0].detail).toContain("missing: kmv-crds");
    expect(rows[0].detail).not.toContain("nothing observed live");
    expect(rows[0].partial).toEqual(partial);
  });

  test("recorded + partial is stale, with the split instead of 'nothing'", () => {
    const liveEvidence = new Map<string, LiveComponentEvidence>([
      ["search-service", { live: false, partial }],
    ]);
    const rows = reconcileStatus("prod", [record()], { liveEvidence });
    expect(rows[0].reconciliation).toBe("stale");
    expect(rows[0].detail).toContain("only 2 of 3 deploy units observed live now");
    expect(rows[0].detail).toContain("missing: kmv-crds");
  });

  test("wholly absent still reads as nothing observed live, no split invented", () => {
    const liveEvidence = new Map<string, LiveComponentEvidence>([["gone", { live: false }]]);
    const rows = reconcileStatus("prod", [], { liveEvidence, allComponents: ["gone"] });
    expect(rows[0].detail).toContain("no release record and nothing observed live");
    expect(rows[0].partial).toBeUndefined();
  });

  test("the split survives mergeLiveEvidence's field-by-field rebuild", () => {
    const base = new Map<string, LiveComponentEvidence>([["operator", { live: false }]]);
    const supplement = new Map<string, LiveComponentEvidence>([["operator", { live: false, partial }]]);
    const merged = mergeLiveEvidence(base, supplement);
    expect(merged.get("operator")!.partial).toEqual(partial);
  });
});
