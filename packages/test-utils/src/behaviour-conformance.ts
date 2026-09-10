/**
 * Behaviour conformance harness (#2356).
 *
 * `packages/core/src/behaviour.ts` says what a `predictBehaviour()` result is
 * allowed to mean. This is the enforcement half — a shared suite every
 * predicting lexicon runs against its own mocked engine, the same way
 * `describeObservationConformance` is shared for the thin read.
 *
 * It lands with the contract rather than with the first implementation (#2357)
 * because every assertion below is about the contract, not about any engine.
 * The refusal case especially: "a missing engine names the variable it wanted"
 * is the rule the epic wrote down, and a rule with no runnable check is a
 * comment. #2357 wires the first real lexicon into this suite; nothing here
 * changes when it does.
 *
 * What it proves, per lexicon:
 *
 *   1. **Shape** — the result is a versioned envelope, and `entities` /
 *      `unpredicted` are disjoint. An entity cannot be both priced and unpriced.
 *   2. **Total over the declared axis** — every name the scenario declared
 *      lands in one map or the other. This is stricter than the thin read's
 *      tri-state on purpose: a prediction has no "the provider says it is not
 *      there", so an entity in neither map is a lexicon that lost one.
 *   3. **Total reasons** — every unpredicted entry names one of
 *      `BEHAVIOUR_UNPREDICTED_REASONS`. No free-form strings, and no
 *      `no-credentials`, which this contract does not have.
 *   4. **Provenance on every number** — every priced entity carries an engine,
 *      a version, a non-empty tolerance and a `basis` from the closed enum, and
 *      states the `at` its figures answer.
 *   5. **A prediction is not a bill** — every cost carries the `per-hour`
 *      discriminant, so no figure in the result can be handed anywhere a charge
 *      is expected.
 *   6. **A refusal is named, never zeroed** — a scenario run with the engine
 *      gone returns the refusal arm, with a switchable cause, a reason that
 *      names an environment variable, and a remedy. It carries no `entities`
 *      map at all, empty or otherwise.
 *
 * Point 6 is the suite's reason to exist. An implementation can satisfy every
 * other check by returning a well-shaped report full of zeroes when its engine
 * is down, and that is the one outcome the epic forbids.
 */

import { describe, it, expect } from "vitest";
import {
  BEHAVIOUR_BASES,
  BEHAVIOUR_UNPREDICTED_REASONS,
  RESILIENCE_VERDICTS,
  isBehaviourRefusalReport,
  isBehaviourResult,
  type BehaviourResult,
} from "../../core/src/behaviour";

/** One scenario: run the lexicon's `predictBehaviour` under its own mocks. */
export interface BehaviourScenario {
  /** Short label, used in the test name. */
  name: string;
  /** Entity names the lexicon was asked about (the declared axis). */
  declared: string[];
  /** Invoke the lexicon's predictBehaviour with its engine mocked. */
  run: () => Promise<BehaviourResult>;
  /**
   * This scenario runs with no reachable engine, and must therefore refuse. The
   * suite then holds the refusal to the contract: a cause from the closed enum,
   * a reason naming an environment variable, a remedy, and no figures anywhere.
   */
  expectRefusal?: boolean;
  /** Entity names this scenario must price. */
  expectPredicted?: string[];
  /**
   * Entity names this scenario must report as unpredicted, optionally pinning
   * the reason — `{ cache: "unsupported-kind" }`. A bare list only requires
   * that they are unpredicted.
   */
  expectUnpredicted?: string[] | Record<string, string>;
}

export interface BehaviourConformanceConfig {
  /** Lexicon name, for test titles. */
  lexicon: string;
  scenarios: BehaviourScenario[];
}

/** The variable names a refusal message is allowed to be pointing at. */
const VARIABLE_PATTERN = /\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b/;

/**
 * Register the conformance suite for one lexicon. Call it from the lexicon's
 * own test file, where its engine mocks live:
 *
 * ```ts
 * describeBehaviourConformance({
 *   lexicon: "acme",
 *   scenarios: [
 *     { name: "prices a bucket", declared: ["data"], run: () => …, expectPredicted: ["data"] },
 *     { name: "engine is gone", declared: ["data"], run: () => …, expectRefusal: true },
 *   ],
 * });
 * ```
 */
export function describeBehaviourConformance(config: BehaviourConformanceConfig): void {
  describe(`behaviour contract conformance (#2356) — ${config.lexicon}`, () => {
    for (const scenario of config.scenarios) {
      describe(scenario.name, () => {
        it("returns a versioned behaviour envelope", async () => {
          expect(isBehaviourResult(await scenario.run())).toBe(true);
        });

        if (scenario.expectRefusal) {
          it("refuses with a named cause rather than an empty report", async () => {
            const result = await scenario.run();
            expect(
              isBehaviourRefusalReport(result),
              "an unreachable engine must return the refusal arm, not a report",
            ).toBe(true);
            if (!isBehaviourRefusalReport(result)) return;
            expect(BEHAVIOUR_UNPREDICTED_REASONS).toContain(result.refusal.cause);
          });

          it("names an environment variable in the refusal, and a remedy", async () => {
            const result = await scenario.run();
            if (!isBehaviourRefusalReport(result)) throw new Error("expected a refusal");
            expect(
              result.refusal.reason,
              "a refusal that names no variable cannot be acted on",
            ).toMatch(VARIABLE_PATTERN);
            expect(result.refusal.remedy.trim().length).toBeGreaterThan(0);
          });

          it("carries no figures at all — not zeroed ones", async () => {
            const result = await scenario.run();
            if (!isBehaviourRefusalReport(result)) throw new Error("expected a refusal");
            // Not "entities is empty": the key must be absent, so nothing
            // downstream can iterate it, sum it, or scale a colour ramp off it.
            expect(Object.prototype.hasOwnProperty.call(result, "entities")).toBe(false);
            expect(Object.prototype.hasOwnProperty.call(result, "meta")).toBe(false);
          });

          return;
        }

        it("keeps priced and unpriced disjoint", async () => {
          const result = await scenario.run();
          if (isBehaviourRefusalReport(result)) throw new Error("expected a report");
          for (const name of Object.keys(result.unpredicted ?? {})) {
            expect(
              Object.prototype.hasOwnProperty.call(result.entities, name),
              `${name} is reported both priced and unpriced`,
            ).toBe(false);
          }
        });

        it("accounts for every declared entity in one map or the other", async () => {
          const result = await scenario.run();
          if (isBehaviourRefusalReport(result)) throw new Error("expected a report");
          const missing = scenario.declared.filter(
            (name) =>
              !Object.prototype.hasOwnProperty.call(result.entities, name) &&
              !Object.prototype.hasOwnProperty.call(result.unpredicted ?? {}, name),
          );
          expect(missing, "declared entities with no verdict at all").toEqual([]);
        });

        it("gives every unpredicted entity a total reason", async () => {
          const result = await scenario.run();
          if (isBehaviourRefusalReport(result)) throw new Error("expected a report");
          for (const [name, entry] of Object.entries(result.unpredicted ?? {})) {
            expect(
              BEHAVIOUR_UNPREDICTED_REASONS,
              `${name} has an unknown reason "${entry.reason}"`,
            ).toContain(entry.reason);
          }
        });

        it("carries provenance, and a basis, on every figure", async () => {
          const result = await scenario.run();
          if (isBehaviourRefusalReport(result)) throw new Error("expected a report");
          for (const [name, block] of Object.entries(result.entities)) {
            expect(block.provenance.engine, `${name} names no engine`).toBeTruthy();
            expect(block.provenance.version, `${name} names no engine version`).toBeTruthy();
            expect(block.provenance.tolerance, `${name} states no tolerance`).toBeTruthy();
            expect(BEHAVIOUR_BASES, `${name} has an unknown basis`).toContain(
              block.provenance.basis,
            );
            expect(block.at.traffic, `${name} states no traffic level`).toBeTruthy();
          }
        });

        it("prices per imagined hour, never as an amount charged", async () => {
          const result = await scenario.run();
          if (isBehaviourRefusalReport(result)) throw new Error("expected a report");
          for (const [name, block] of Object.entries(result.entities)) {
            expect(block.cost.rate, `${name}'s cost is not a per-hour rate`).toBe("per-hour");
            expect(block.cost.currency, `${name} names no currency`).toBeTruthy();
          }
          if (result.meta.total) expect(result.meta.total.rate).toBe("per-hour");
        });

        it("reports a resilience verdict from the closed set", async () => {
          const result = await scenario.run();
          if (isBehaviourRefusalReport(result)) throw new Error("expected a report");
          for (const [name, block] of Object.entries(result.entities)) {
            expect(RESILIENCE_VERDICTS, `${name} has an unknown verdict`).toContain(
              block.resilience.verdict,
            );
            expect(block.resilience.failure, `${name} names no failure`).toBeTruthy();
          }
        });

        it("leaves an unmodeled headroom axis absent rather than zero", async () => {
          const result = await scenario.run();
          if (isBehaviourRefusalReport(result)) throw new Error("expected a report");
          for (const [name, block] of Object.entries(result.entities)) {
            for (const axis of ["cpu", "latency"] as const) {
              const value = block.headroom[axis];
              if (value === undefined) continue;
              expect(value, `${name}'s ${axis} headroom is out of 0..1`).toBeGreaterThanOrEqual(0);
              expect(value, `${name}'s ${axis} headroom is out of 0..1`).toBeLessThanOrEqual(1);
            }
          }
        });

        if (scenario.expectPredicted) {
          it("prices the entities the scenario says it can", async () => {
            const result = await scenario.run();
            if (isBehaviourRefusalReport(result)) throw new Error("expected a report");
            for (const name of scenario.expectPredicted ?? []) {
              expect(
                Object.prototype.hasOwnProperty.call(result.entities, name),
                `${name} was expected to be priced`,
              ).toBe(true);
            }
          });
        }

        if (scenario.expectUnpredicted) {
          it("declines the entities the scenario says it cannot", async () => {
            const result = await scenario.run();
            if (isBehaviourRefusalReport(result)) throw new Error("expected a report");
            const expected = Array.isArray(scenario.expectUnpredicted)
              ? Object.fromEntries(scenario.expectUnpredicted.map((n) => [n, undefined]))
              : scenario.expectUnpredicted;
            for (const [name, reason] of Object.entries(expected ?? {})) {
              const entry = (result.unpredicted ?? {})[name];
              expect(entry, `${name} was expected to be unpriced`).toBeDefined();
              if (reason !== undefined) expect(entry?.reason).toBe(reason);
            }
          });
        }
      });
    }
  });
}
