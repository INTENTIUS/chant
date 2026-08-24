/**
 * Observation conformance harness (#1089).
 *
 * The contract in `packages/core/src/observation.ts` says what a
 * `describeResources()` result is allowed to mean. Documentation does not
 * enforce, so this is the enforcement half: a shared suite every observing
 * lexicon runs against its own mocked transport, the same way
 * `describeExample` / `describeAllExamples` are shared for examples.
 *
 * What it proves, per lexicon:
 *
 *   1. **Shape** — the result normalizes, and `resources` / `unobserved` are
 *      disjoint. An entity cannot be both read and not-read.
 *   2. **Total reasons** — every unobserved entry names one of
 *      `UNOBSERVED_REASONS`. No free-form strings, no missing verdicts.
 *   3. **Total ownership** — every returned resource's `ownership`, when
 *      present, is `owned` / `foreign` / `unknown`. A lexicon that cannot read
 *      the marker on this path says `unknown` instead of degrading silently.
 *   4. **Marker identity** (#1222) — a lexicon that stamps stack/env markers
 *      surfaces them on reads: markers are well-formed, a marker-carrying
 *      resource on a declared describeResources channel classifies `owned`,
 *      and scenario expectations (`expectMarker`/`expectNoMarker`) pin the
 *      identity verbatim — absent channel, absent field.
 *   5. **Unobservable ≠ absent** — the case that motivated the issue. Given a
 *      scenario the lexicon cannot read (an unsupported kind, a failing
 *      transport, missing credentials), the entity appears in `unobserved`,
 *      does NOT appear in `resources`, and — run through the real
 *      `buildChangeSet` — classifies as `unobserved` rather than `create`.
 *
 * Point 5 is the whole suite's reason to exist: it runs the lexicon's output
 * through core's actual change-set classifier, so a lexicon cannot pass by
 * returning a well-shaped result that still ends up proposing a create.
 */

import { describe, it, expect } from "vitest";
import { buildChangeSet } from "../../core/src/lifecycle/change-set";
import {
  UNOBSERVED_REASONS,
  normalizeObservation,
  type DescribeResourcesResult,
} from "../../core/src/observation";
import { resolvesOwnershipOn, type OwnershipChannel, type OwnershipMarker } from "../../core/src/ownership";

/** One scenario: run the lexicon's `describeResources` under its own mocks. */
export interface ObservationScenario {
  /** Short label, used in the test name. */
  name: string;
  /** Entity names the lexicon was asked about (the declared axis). */
  declared: string[];
  /** Invoke the lexicon's describeResources with its transport mocked. */
  run: () => Promise<DescribeResourcesResult>;
  /**
   * Entity names this scenario must report as NOT-OBSERVED. When set, the suite
   * also asserts each one classifies as `unobserved` — never `create` — through
   * core's own change set.
   */
  expectUnobserved?: string[];
  /**
   * Entity names this scenario must report as OBSERVED-ABSENT: in neither map,
   * because the provider was asked and said they are not there. These are
   * allowed — and expected — to classify as `create`.
   */
  expectAbsent?: string[];
  /** Entity names this scenario must report as OBSERVED-PRESENT. */
  expectPresent?: string[];
  /**
   * This scenario ran with `owned: true` (#1348). The suite then holds the
   * lexicon to its declared marker channel: a real verdict where it claims one,
   * `unknown` where it does not.
   */
  owned?: boolean;
  /**
   * Expected marker identity per entity name (#1222). A lexicon that stamps
   * stack/env markers must also surface them on reads: each entity listed here
   * must come back with exactly this `ResourceMetadata.marker`. The identity is
   * verbatim — what the tags/labels carry, not what the caller wishes.
   */
  expectMarker?: Record<string, OwnershipMarker>;
  /**
   * Entity names that must surface NO marker (#1222) — the live model carries
   * no marker channel for them, or the managed-by marker is absent. Absent
   * channel means absent field, never a guess or an app-boundary inference.
   */
  expectNoMarker?: string[];
}

export interface ObservationConformanceConfig {
  /** Lexicon name, for test titles. */
  lexicon: string;
  scenarios: ObservationScenario[];
  /**
   * The lexicon's declared marker channel — pass `plugin.ownershipChannel`
   * (#1348).
   *
   * Supplying it turns the ownership assertion from a shape check into a
   * behavioral one. Without it the suite could only confirm that a verdict, if
   * present, was one of three strings; it could not tell a lexicon that read
   * the marker from one that quietly returned nothing. With it, a lexicon
   * declaring `describeResources` must produce `owned`/`foreign` on an owned
   * read, and a lexicon declaring no channel must produce `unknown` — the
   * silent degradation `ResourceMetadata.ownership` forbids and nothing
   * checked.
   */
  ownershipChannel?: OwnershipChannel;
}

/**
 * Register the conformance suite for one lexicon. Call it from the lexicon's
 * own test file, where its transport mocks live:
 *
 * ```ts
 * describeObservationConformance({
 *   lexicon: "k8s",
 *   scenarios: [{ name: "CRD kind has no reader", declared: ["widget"], run: () => …, expectUnobserved: ["widget"] }],
 * });
 * ```
 */
export function describeObservationConformance(config: ObservationConformanceConfig): void {
  describe(`observation contract conformance (#1089) — ${config.lexicon}`, () => {
    for (const scenario of config.scenarios) {
      describe(scenario.name, () => {
        it("returns a well-formed observation: present and not-observed are disjoint", async () => {
          const { resources, unobserved } = normalizeObservation(await scenario.run());
          for (const name of Object.keys(unobserved)) {
            expect(
              Object.prototype.hasOwnProperty.call(resources, name),
              `${name} is reported both present and not-observed`,
            ).toBe(false);
          }
        });

        it("gives every not-observed entity a total reason", async () => {
          const { unobserved } = normalizeObservation(await scenario.run());
          for (const [name, entry] of Object.entries(unobserved)) {
            expect(UNOBSERVED_REASONS, `${name} has an unknown reason "${entry.reason}"`).toContain(
              entry.reason,
            );
          }
        });

        it("gives every returned resource a total ownership verdict", async () => {
          const { resources } = normalizeObservation(await scenario.run());
          for (const [name, meta] of Object.entries(resources)) {
            if (meta.ownership === undefined) continue; // absent is read as unknown
            expect(
              ["owned", "foreign", "unknown"],
              `${name} has a non-total ownership verdict "${meta.ownership}"`,
            ).toContain(meta.ownership);
          }
        });

        it("surfaces only well-formed marker identity (#1222)", async () => {
          const { resources } = normalizeObservation(await scenario.run());
          for (const [name, meta] of Object.entries(resources)) {
            if (meta.marker === undefined) continue; // absent channel → absent field
            expect(typeof meta.marker.stack, `${name}: marker.stack must be a string`).toBe("string");
            if (meta.marker.env !== undefined) {
              expect(typeof meta.marker.env, `${name}: marker.env must be a string when set`).toBe("string");
            }
          }
        });

        if (resolvesOwnershipOn(config.ownershipChannel, "describeResources")) {
          it("classifies every marker-carrying resource as owned, since the marker IS the channel (#1222)", async () => {
            // On a declared describeResources channel, a surfaced marker is the
            // managed-by stamp itself — a resource carrying one that still
            // reads `foreign`/`unknown` read the channel and ignored it.
            const { resources } = normalizeObservation(await scenario.run());
            for (const [name, meta] of Object.entries(resources)) {
              if (meta.marker === undefined) continue;
              expect(
                meta.ownership,
                `${name}: surfaces a marker on ${config.lexicon}'s declared describeResources channel but classifies as "${meta.ownership ?? "unknown"}"`,
              ).toBe("owned");
            }
          });
        }

        if (scenario.expectMarker && Object.keys(scenario.expectMarker).length > 0) {
          it("surfaces the stamped stack/env identity verbatim (#1222)", async () => {
            const { resources } = normalizeObservation(await scenario.run());
            for (const [name, expected] of Object.entries(scenario.expectMarker!)) {
              const meta = resources[name];
              expect(meta, `${name} should be observed present to carry a marker`).toBeDefined();
              expect(meta!.marker, `${name}: the live model carries the channel, so the marker must be surfaced`).toBeDefined();
              expect(meta!.marker!.stack).toBe(expected.stack);
              expect(meta!.marker!.env).toBe(expected.env);
            }
          });
        }

        if (scenario.expectNoMarker?.length) {
          it("leaves the marker absent where the live model carries none — never a guess (#1222)", async () => {
            const { resources } = normalizeObservation(await scenario.run());
            for (const name of scenario.expectNoMarker!) {
              const meta = resources[name];
              expect(meta, `${name} should be observed present`).toBeDefined();
              expect(
                meta!.marker,
                `${name} carries no marker channel in the live model but surfaced one`,
              ).toBeUndefined();
            }
          });
        }

        if (scenario.owned) {
          const resolves = resolvesOwnershipOn(config.ownershipChannel, "describeResources");
          it(
            resolves
              ? "resolves a real verdict on an owned read, since it declares a marker channel here"
              : "answers unknown on an owned read, since it declares no marker channel here",
            async () => {
              const { resources } = normalizeObservation(await scenario.run());
              for (const [name, meta] of Object.entries(resources)) {
                const verdict = meta.ownership ?? "unknown";
                if (resolves) {
                  // Declaring the channel is a claim. `unknown` here means the
                  // claim is wrong, and an `unknown` never becomes a delete —
                  // so the filter silently returns everything instead.
                  expect(
                    ["owned", "foreign"],
                    `${name}: ${config.lexicon} declares a describeResources marker channel but answered "${verdict}"`,
                  ).toContain(verdict);
                } else {
                  // The degradation the contract forbids: claiming ownership
                  // from a path that cannot read the marker.
                  expect(
                    verdict,
                    `${name}: ${config.lexicon} declares no describeResources marker channel but answered "${verdict}"`,
                  ).toBe("unknown");
                }
              }
            },
          );
        }

        if (scenario.expectPresent?.length) {
          it("reports the expected entities as observed present", async () => {
            const { resources } = normalizeObservation(await scenario.run());
            for (const name of scenario.expectPresent!) {
              expect(Object.keys(resources)).toContain(name);
            }
          });
        }

        if (scenario.expectUnobserved?.length) {
          it("reports unreadable entities as not-observed, never as absent", async () => {
            const { resources, unobserved } = normalizeObservation(await scenario.run());
            for (const name of scenario.expectUnobserved!) {
              expect(Object.keys(unobserved), `${name} should be reported unobserved`).toContain(name);
              expect(Object.keys(resources)).not.toContain(name);
            }
          });

          it("never becomes a create in the change set", async () => {
            const observed = normalizeObservation(await scenario.run());
            const cs = buildChangeSet("conformance", {
              declared: new Set(scenario.declared),
              observedNow: observed.resources,
              observedThen: undefined,
              unobserved: observed.unobserved,
            });
            for (const name of scenario.expectUnobserved!) {
              const entry = cs.entries.find((e) => e.name === name);
              expect(entry, `${name} is missing from the change set entirely`).toBeDefined();
              expect(entry!.action).toBe("unobserved");
              expect(entry!.evidence.observed).toBe(false);
            }
          });
        }

        if (scenario.expectAbsent?.length) {
          it("reports confirmed-absent entities as absent, and only those become creates", async () => {
            const observed = normalizeObservation(await scenario.run());
            const cs = buildChangeSet("conformance", {
              declared: new Set(scenario.declared),
              observedNow: observed.resources,
              observedThen: undefined,
              unobserved: observed.unobserved,
            });
            for (const name of scenario.expectAbsent!) {
              expect(Object.keys(observed.resources)).not.toContain(name);
              expect(Object.keys(observed.unobserved)).not.toContain(name);
              const entry = cs.entries.find((e) => e.name === name);
              expect(entry?.action).toBe("create");
              expect(entry?.evidence.observed).toBe(true);
            }
          });
        }
      });
    }
  });
}
