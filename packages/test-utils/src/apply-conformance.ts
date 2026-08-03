/**
 * Apply conformance harness (#1446).
 *
 * The contract in `packages/core/src/apply.ts` says what an applier's result is
 * allowed to mean. Documentation does not enforce, so this is the enforcement
 * half: a shared suite every applying lexicon runs against its own mocked
 * transport — the exact shape `observation-conformance.ts` takes on the read
 * side.
 *
 * What it proves, per applier:
 *
 *   1. **Shape** — the result normalizes, and the three buckets are disjoint. A
 *      resource cannot be both written and skipped.
 *   2. **Total reasons** — every not-attempted entry names one of
 *      `NOT_ATTEMPTED_REASONS`, and every applied entry a legal action. No
 *      free-form strings.
 *   3. **Nothing is dropped** — every resource in the plan appears in exactly
 *      one bucket. This is the assertion gcp failed before #1447, and the whole
 *      suite's reason to exist.
 *   4. **Owned-only prune** — given a foreign resource and an owned orphan of
 *      the same kind in the same scope, prune deletes exactly one, and the
 *      foreign one is never issued a delete. **Asserted on the transport**, not
 *      on the return value: an applier that returns a tidy result while issuing
 *      a delete against a stranger's resource passes every other check here.
 *   5. **Idempotence** — applying the same plan twice reports no `created` the
 *      second time. Every applier claims this; none of them tested it.
 *
 * Point 3 is the one that would have caught #1447 and #1457. Point 4 is the one
 * that would have caught #1448, where `owned-only` on the arm target ran ARM
 * Complete mode and deleted at resource-group scope.
 */

import { describe, it, expect } from "vitest";
import {
  NOT_ATTEMPTED_REASONS,
  APPLIED_ACTIONS,
  normalizeApply,
  overlappingRefs,
  unaccountedRefs,
  applyRefKey,
  type ApplyRef,
  type ApplyResult,
  type NormalizedApply,
} from "../../core/src/apply";

/** One scenario: run the lexicon's applier under its own mocked transport. */
export interface ApplyScenario {
  /** Short label, used in the test name. */
  name: string;
  /**
   * The resources the applier was handed — the plan axis. Every one of these
   * must come back accounted for in exactly one bucket.
   */
  plan: ApplyRef[];
  /** Invoke the lexicon's applier with its transport mocked. */
  run: () => Promise<ApplyResult | Partial<NormalizedApply>>;
  /** Resources this scenario must report NOT-ATTEMPTED, as `kind/name`. */
  expectNotAttempted?: string[];
  /** Resources this scenario must report APPLIED, as `kind/name`. */
  expectApplied?: string[];
  /** Resources this scenario must report PRUNED, as `kind/name`. */
  expectPruned?: string[];
}

/**
 * The owned-only prune scenario, asserted on the transport (#1446 assertion 4).
 *
 * Separate from {@link ApplyScenario} because it needs the delete calls the
 * transport saw, which a return value cannot stand in for — that is the whole
 * point of #1448.
 */
export interface PruneScenario {
  name: string;
  /**
   * Run a prune against a scope holding both an owned orphan and a foreign
   * resource, and report every delete the transport was asked to issue.
   */
  run: () => Promise<{ result: ApplyResult | Partial<NormalizedApply>; deletes: string[] }>;
  /**
   * A substring identifying the owned orphan in a delete target (a URL, an id).
   * Exactly one delete must match it.
   */
  ownedOrphan: string;
  /**
   * A substring identifying the foreign resource. **No** delete may match it.
   */
  foreign: string;
}

/** Applying the same plan twice must not report a second round of creates. */
export interface IdempotenceScenario {
  name: string;
  /** Run the same apply twice against a transport that remembers the first. */
  run: () => Promise<{
    first: ApplyResult | Partial<NormalizedApply>;
    second: ApplyResult | Partial<NormalizedApply>;
  }>;
}

export interface ApplyConformanceConfig {
  /** Lexicon name, for test titles. */
  lexicon: string;
  scenarios: ApplyScenario[];
  /** Optional — an applier with no prune has nothing to assert here. */
  pruneScenarios?: PruneScenario[];
  /** Optional, but every applier claims idempotence, so its absence is a gap. */
  idempotenceScenarios?: IdempotenceScenario[];
}

/**
 * Register the conformance suite for one lexicon. Call it from the lexicon's own
 * test file, where its transport mocks live:
 *
 * ```ts
 * describeApplyConformance({
 *   lexicon: "gcp",
 *   scenarios: [{
 *     name: "unmapped kind",
 *     plan: [{ kind: "StorageBucket", name: "a" }, { kind: "SQLInstance", name: "b" }],
 *     run: () => gcpApply(args, undefined, mockHttp).then(toApplyResult),
 *     expectNotAttempted: ["SQLInstance/b"],
 *   }],
 * });
 * ```
 */
export function describeApplyConformance(config: ApplyConformanceConfig): void {
  describe(`apply contract conformance (#1446) — ${config.lexicon}`, () => {
    for (const scenario of config.scenarios) {
      describe(scenario.name, () => {
        it("returns a well-formed result: the three buckets are disjoint", async () => {
          const overlaps = overlappingRefs(normalizeApply(await scenario.run()));
          expect(overlaps, `reported in more than one bucket: ${overlaps.join(", ")}`).toEqual([]);
        });

        it("gives every not-attempted resource a total reason", async () => {
          const { notAttempted } = normalizeApply(await scenario.run());
          for (const entry of notAttempted) {
            expect(
              NOT_ATTEMPTED_REASONS,
              `${applyRefKey(entry)} has an unknown reason "${entry.reason}"`,
            ).toContain(entry.reason);
          }
        });

        it("gives every applied resource a total action", async () => {
          const { applied } = normalizeApply(await scenario.run());
          for (const entry of applied) {
            expect(
              APPLIED_ACTIONS,
              `${applyRefKey(entry)} has a non-total action "${entry.action}"`,
            ).toContain(entry.action);
          }
        });

        // The assertion the whole suite exists for.
        it("accounts for every resource in the plan", async () => {
          const dropped = unaccountedRefs(scenario.plan, normalizeApply(await scenario.run()));
          expect(
            dropped,
            `silently dropped — in the plan, in no bucket: ${dropped.join(", ")}`,
          ).toEqual([]);
        });

        const expectedNotAttempted = scenario.expectNotAttempted;
        if (expectedNotAttempted?.length) {
          it("reports the expected resources as not-attempted", async () => {
            const { notAttempted } = normalizeApply(await scenario.run());
            expect(notAttempted.map(applyRefKey).sort()).toEqual([...expectedNotAttempted].sort());
          });
        }

        const expectedApplied = scenario.expectApplied;
        if (expectedApplied?.length) {
          it("reports the expected resources as applied", async () => {
            const { applied } = normalizeApply(await scenario.run());
            expect(applied.map(applyRefKey).sort()).toEqual([...expectedApplied].sort());
          });
        }

        const expectedPruned = scenario.expectPruned;
        if (expectedPruned?.length) {
          it("reports the expected resources as pruned", async () => {
            const { pruned } = normalizeApply(await scenario.run());
            expect(pruned.map(applyRefKey).sort()).toEqual([...expectedPruned].sort());
          });
        }
      });
    }

    for (const scenario of config.pruneScenarios ?? []) {
      describe(`owned-only prune — ${scenario.name}`, () => {
        it("issues no delete against the foreign resource", async () => {
          const { deletes } = await scenario.run();
          const wrong = deletes.filter((d) => d.includes(scenario.foreign));
          expect(
            wrong,
            `deleted a resource chant does not own: ${wrong.join(", ")}`,
          ).toEqual([]);
        });

        it("issues exactly one delete, against the owned orphan", async () => {
          const { deletes } = await scenario.run();
          expect(deletes.filter((d) => d.includes(scenario.ownedOrphan))).toHaveLength(1);
          expect(deletes).toHaveLength(1);
        });

        it("reports the orphan as pruned", async () => {
          const { result } = await scenario.run();
          const { pruned } = normalizeApply(result);
          expect(pruned.length).toBeGreaterThan(0);
        });
      });
    }

    for (const scenario of config.idempotenceScenarios ?? []) {
      describe(`idempotence — ${scenario.name}`, () => {
        it("creates nothing on the second apply of the same plan", async () => {
          const { first, second } = await scenario.run();
          expect(normalizeApply(first).applied.some((a) => a.action === "created")).toBe(true);
          const created = normalizeApply(second).applied.filter((a) => a.action === "created");
          expect(
            created.map(applyRefKey),
            `created again on the second apply: ${created.map(applyRefKey).join(", ")}`,
          ).toEqual([]);
        });
      });
    }
  });
}
