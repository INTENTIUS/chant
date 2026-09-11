/**
 * The `cost` clause on a scenario (#2358): its shape at declaration, and its
 * evaluation against the fixture's recorded prediction.
 */

import { describe, expect, test } from "vitest";
import { EXPECT_KEYS, Scenario, snapshot } from "./scenario";
import { evaluateScenario, type ScenarioBehaviourFixture } from "./scenario-eval";
import type { ChangeSet } from "./change-set";
import {
  behaviourReport,
  noBehaviourEngineRefusal,
  outOfCreditBehaviourEngineRefusal,
  predictedRate,
  type PredictedBehaviour,
  type UnpredictedEntity,
} from "../behaviour";

const EMPTY: ChangeSet = { env: "prod", entries: [] };
const TRAFFIC = "100 rps, p50";

function figure(perHour: number, currency = "USD"): PredictedBehaviour {
  return {
    at: { traffic: TRAFFIC },
    cost: predictedRate(perHour, currency),
    headroom: { cpu: 0.5 },
    errorRate: 0.001,
    resilience: { failure: "one zone lost", verdict: "survives" },
    provenance: { engine: "acme-sim", version: "1.4.2", tolerance: "±15%", basis: "modeled" },
  };
}

function fixture(
  entities: Record<string, PredictedBehaviour>,
  unpredicted: Record<string, UnpredictedEntity> = {},
  total?: { perHour: number; currency: string },
): ScenarioBehaviourFixture {
  return {
    result: behaviourReport(
      { entityNames: [...Object.keys(entities), ...Object.keys(unpredicted)], traffic: TRAFFIC, edgeCoverage: { verdict: "unknown" } },
      { engine: "acme-sim", version: "1.4.2", ...(total ? { total: predictedRate(total.perHour, total.currency) } : {}) },
      entities,
      unpredicted,
    ),
  };
}

function cost(verdict: ReturnType<typeof evaluateScenario>) {
  return verdict.checks.find((c) => c.clause === "cost")!;
}

describe("Scenario — the cost clause's shape", () => {
  test("cost is a recognized expect key", () => {
    expect(EXPECT_KEYS).toContain("cost");
  });

  test("accepts a bound with a currency, and an optional entity", () => {
    const s = Scenario("s", { given: snapshot("fixtures/prod.json"), expect: { cost: { maxPerHour: 12.5, currency: "USD" } } });
    expect(s.expect.cost).toEqual({ maxPerHour: 12.5, currency: "USD" });
    const e = Scenario("s", { given: snapshot("prod"), expect: { cost: { maxPerHour: 1, currency: " EUR ", entity: "db" } } });
    expect(e.expect.cost).toEqual({ maxPerHour: 1, currency: "EUR", entity: "db" });
    expect(Object.isFrozen(e.expect.cost)).toBe(true);
  });

  test("composes with the other clauses", () => {
    const s = Scenario("s", { given: snapshot("prod"), expect: { noop: true, cost: { maxPerHour: 1, currency: "USD" } } });
    expect(Object.keys(s.expect).sort()).toEqual(["cost", "noop"]);
  });

  test("rejects a bound with no currency — chant converts nothing", () => {
    expect(() =>
      // @ts-expect-error deliberately omitting currency
      Scenario("s", { given: snapshot("prod"), expect: { cost: { maxPerHour: 1 } } }),
    ).toThrow(/expect.cost.currency/);
  });

  test("rejects a negative, non-finite or non-numeric bound", () => {
    expect(() => Scenario("s", { given: snapshot("prod"), expect: { cost: { maxPerHour: -1, currency: "USD" } } })).toThrow(/non-negative finite/);
    expect(() => Scenario("s", { given: snapshot("prod"), expect: { cost: { maxPerHour: Number.NaN, currency: "USD" } } })).toThrow(/non-negative finite/);
    expect(() =>
      // @ts-expect-error deliberately passing a string
      Scenario("s", { given: snapshot("prod"), expect: { cost: { maxPerHour: "12", currency: "USD" } } }),
    ).toThrow(/non-negative finite/);
  });

  test("rejects an unknown field inside cost, and a non-object cost", () => {
    expect(() =>
      // @ts-expect-error deliberately passing an unrecognized field
      Scenario("s", { given: snapshot("prod"), expect: { cost: { maxPerHour: 1, currency: "USD", maxPerMonth: 700 } } }),
    ).toThrow(/unknown `expect.cost` field "maxPerMonth"/);
    expect(() =>
      // @ts-expect-error deliberately passing a number
      Scenario("s", { given: snapshot("prod"), expect: { cost: 12 } }),
    ).toThrow(/must be \{ maxPerHour, currency, entity\? \}/);
  });
});

describe("evaluateScenario — cost against the fixture's recorded prediction", () => {
  test("a fixture with no behaviour block fails the clause by name — a bound cannot be checked against no figure", () => {
    const verdict = evaluateScenario(EMPTY, { cost: { maxPerHour: 1, currency: "USD" } }, { missing: "given fixtures/prod.json carries no `behaviour` block" });
    expect(verdict.pass).toBe(false);
    expect(cost(verdict).detail).toMatch(/carries no `behaviour` block.*Record one/);
    // And with nothing handed over at all.
    expect(evaluateScenario(EMPTY, { cost: { maxPerHour: 1, currency: "USD" } }).pass).toBe(false);
  });

  test("a fixture whose prediction is a refusal fails with the refusal's reason, never a pass on nothing", () => {
    const verdict = evaluateScenario(EMPTY, { cost: { maxPerHour: 1e9, currency: "USD" } }, { result: noBehaviourEngineRefusal("chant") });
    expect(verdict.pass).toBe(false);
    expect(cost(verdict).detail).toContain("the fixture's prediction is a refusal (no-engine)");
    expect(cost(verdict).detail).toContain("Set CHANT_BEHAVIOUR_ENGINE to the engine's address.");

    const broke = outOfCreditBehaviourEngineRefusal("chant", { value: "engine", source: "CHANT_BEHAVIOUR_ENGINE" }, "balance 0");
    expect(cost(evaluateScenario(EMPTY, { cost: { maxPerHour: 1e9, currency: "USD" } }, { result: broke })).detail).toContain("engine-out-of-credit");
  });

  test("turns red when the fixture's figure exceeds the bound, naming both rates and the level", () => {
    const verdict = evaluateScenario(EMPTY, { cost: { maxPerHour: 0.25, currency: "USD" } }, fixture({ db: figure(0.272) }));
    expect(verdict.pass).toBe(false);
    expect(cost(verdict).detail).toBe(
      'exceeded: 0.272 USD/hour at "100 rps, p50" against a bound of 0.25 USD/hour; read from chant\'s own sum over 1 predicted entity (the engine states no total)',
    );
  });

  test("passes at or under the bound, and says on the pass which figure it read", () => {
    const verdict = evaluateScenario(EMPTY, { cost: { maxPerHour: 0.272, currency: "USD" } }, fixture({ db: figure(0.272) }));
    expect(verdict.pass).toBe(true);
    expect(cost(verdict).detail).toContain("read from chant's own sum");
  });

  test("reads the engine's own total when it states one, rather than summing", () => {
    const verdict = evaluateScenario(EMPTY, { cost: { maxPerHour: 1, currency: "USD" } }, fixture({ db: figure(0.272), web: figure(0.04) }, {}, { perHour: 1.5, currency: "USD" }));
    expect(verdict.pass).toBe(false);
    expect(cost(verdict).detail).toContain("1.5 USD/hour");
    expect(cost(verdict).detail).toContain("read from the engine's own estate total (acme-sim 1.4.2)");
  });

  test("chant's sum names every declined entity, because those are in the estate and not in the sum", () => {
    const verdict = evaluateScenario(
      EMPTY,
      { cost: { maxPerHour: 1, currency: "USD" } },
      fixture({ db: figure(0.272) }, { role: { type: "AWS::IAM::Role", reason: "unsupported-kind", detail: "a role is a grant" } }),
    );
    expect(verdict.pass).toBe(true);
    expect(cost(verdict).detail).toContain("1 declined and not in the figure: role (unsupported-kind: a role is a grant)");
  });

  test("bounds one entity's own rate when named, with its provenance", () => {
    const fx = fixture({ db: figure(0.272), web: figure(5) });
    expect(evaluateScenario(EMPTY, { cost: { maxPerHour: 0.3, currency: "USD", entity: "db" } }, fx).pass).toBe(true);
    const red = evaluateScenario(EMPTY, { cost: { maxPerHour: 0.3, currency: "USD", entity: "web" } }, fx);
    expect(red.pass).toBe(false);
    expect(cost(red).detail).toContain("read from web's own rate (acme-sim 1.4.2, ±15%, modeled)");
  });

  test("a named entity the engine declined, or never asked about, fails with the reason", () => {
    const fx = fixture({ db: figure(0.272) }, { role: { reason: "unsupported-kind", detail: "a role is a grant" } });
    expect(cost(evaluateScenario(EMPTY, { cost: { maxPerHour: 1, currency: "USD", entity: "role" } }, fx)).detail).toContain(
      '"role" was declined by the engine (unsupported-kind: a role is a grant)',
    );
    expect(cost(evaluateScenario(EMPTY, { cost: { maxPerHour: 1, currency: "USD", entity: "ghost" } }, fx)).detail).toContain(
      '"ghost" is in neither the fixture\'s figures nor its declined entities',
    );
  });

  test("a bound in another currency fails — chant converts nothing", () => {
    const verdict = evaluateScenario(EMPTY, { cost: { maxPerHour: 1, currency: "EUR" } }, fixture({ db: figure(0.272) }));
    expect(verdict.pass).toBe(false);
    expect(cost(verdict).detail).toContain("the bound is in EUR and the figure is 0.272 USD/hour");
  });

  test("entities priced in two currencies with no engine total cannot be summed", () => {
    const verdict = evaluateScenario(EMPTY, { cost: { maxPerHour: 1, currency: "USD" } }, fixture({ db: figure(0.272), eu: figure(0.1, "EUR") }));
    expect(verdict.pass).toBe(false);
    expect(cost(verdict).detail).toContain("priced in EUR, USD");
  });

  test("the cost clause sits beside the others in declaration order and does not touch them", () => {
    const verdict = evaluateScenario(EMPTY, { noop: true, cost: { maxPerHour: 1, currency: "USD" } }, fixture({ db: figure(0.272) }));
    expect(verdict.checks.map((c) => c.clause)).toEqual(["noop", "cost"]);
    expect(verdict.pass).toBe(true);
  });
});
