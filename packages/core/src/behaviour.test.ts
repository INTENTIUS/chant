/**
 * The behaviour prediction contract (#2356).
 *
 * Two halves. The first is a test lexicon — `acme-sim` below — that implements
 * `predictBehaviour()` against a fixture engine, run through the shared
 * conformance suite so the contract's rules are checked by the same code every
 * real lexicon will be checked by (#2357 onwards).
 *
 * The second half is the four rules the epic states, each one asserted where it
 * is actually enforced. Three of them are enforced by the type system, so their
 * assertions are `@ts-expect-error` and their red is a typecheck failure, not a
 * vitest one. That is the point: a rule enforced at runtime is a rule a lexicon
 * author discovers after shipping.
 */

import { describe, test, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  describeBehaviourConformance,
  behaviourConformanceGaps,
  probeTrafficLevel,
  probeReadsEdges,
  probeEdgelessConsistency,
  probeEchoesCoverage,
} from "@intentius/chant-test-utils";
import type { LexiconPlugin } from "./lexicon";
import type { IREdge } from "./graph-ir";
import {
  BEHAVIOUR_BASES,
  BEHAVIOUR_UNPREDICTED_REASONS,
  assertNoCredentialInOptions,
  copyEdgeCoverage,
  behaviourEngineFrom,
  behaviourEngineVariables,
  behaviourReport,
  compareFigures,
  compareProvenance,
  figureMismatches,
  findCredentialsInOptions,
  screenBehaviourRequest,
  validateEdgeCoverage,
  FIGURE_MISMATCHES,
  isComparableFigure,
  isComparableProvenance,
  isEdgeCoverageVerdict,
  outOfCreditBehaviourEngineRefusal,
  overQuotaBehaviourEngineRefusal,
  redactEngineAddress,
  validateBehaviourBlock,
  EDGE_COVERAGE_VERDICTS,
  RESILIENCE_VERDICTS,
  isBehaviourBasis,
  isBehaviourRefusalReport,
  isBehaviourResult,
  isBehaviourUnpredictedReason,
  noBehaviourEngineMessage,
  noBehaviourEngineRefusal,
  predictedRate,
  renderBehaviourRefusal,
  unreachableBehaviourEngineRefusal,
  type BehaviourHeadroom,
  type FigureMismatch,
  type BehaviourResult,
  type BehaviourUnpredictedReason,
  type PredictBehaviourOptions,
  type PredictedRate,
  type PredictedBehaviour,
} from "./behaviour";

/* -------------------------------------------------------------------------- */
/* The fixture engine, and a lexicon that predicts against it                 */
/* -------------------------------------------------------------------------- */

/**
 * What a behaviour engine answers with. A fixture, not a client: it stands in
 * for whatever #2359's first adapter talks to, and its only job here is to be
 * present in one test and absent in the other.
 */
const FIXTURE_ENGINE: Record<string, { perHour: number; cpu: number; latency: number }> = {
  "AWS::EC2::Instance": { perHour: 0.0416, cpu: 0.62, latency: 0.41 },
  "AWS::RDS::DBInstance": { perHour: 0.272, cpu: 0.35, latency: 0.28 },
};

const FIXTURE_ENGINE_VERSION = "1.4.2";

/** Six significant figures, so a float comparison in a test is stable. */
const round = (n: number): number => Number(n.toPrecision(6));

/**
 * How busy the stated level is, relative to the fixture's 100 rps baseline. The
 * fixture reads the level rather than echoing it; a `×10` suffix (which the
 * conformance suite appends when probing) multiplies.
 */
function trafficIntensity(traffic: string): number {
  const multiplier = /×\s*(\d+(?:\.\d+)?)/.exec(traffic);
  const rps = /(\d+(?:\.\d+)?)\s*rps/i.exec(traffic);
  const base = rps ? Number(rps[1]) / 100 : 1;
  return base * (multiplier ? Number(multiplier[1]) : 1);
}

/** The declared estate the lexicon is asked about, in both scenarios. */
const DECLARED = new Map<string, { entityType: string; props: Record<string, unknown> }>([
  ["web", { entityType: "AWS::EC2::Instance", props: { instanceType: "t3.medium" } }],
  ["db", { entityType: "AWS::RDS::DBInstance", props: { instanceClass: "db.t3.medium" } }],
  ["queue", { entityType: "AWS::SQS::Queue", props: {} }],
]);

/**
 * The edges between them. `web` reads the queue and writes the database, which
 * is the whole reason an engine can say anything about a path rather than about
 * three boxes in isolation.
 */
const EDGES: IREdge[] = [
  { from: "web", to: "db", kind: "ref", viaAttr: "dbEndpoint", toAttr: "endpoint" },
  { from: "web", to: "queue", kind: "ref", viaAttr: "queueUrl", toAttr: "url" },
];

const REQUEST: PredictBehaviourOptions = {
  environment: "prod",
  buildOutput: "/tmp/build",
  entityNames: [...DECLARED.keys()],
  entities: DECLARED,
  edges: EDGES,
  edgeCoverage: { verdict: "complete" },
  region: "us-east-1",
  traffic: "100 rps, p50",
};

/**
 * A lexicon that predicts. It resolves its engine from the environment first —
 * refusing by name when nothing does — and only then prices anything, which is
 * the ordering the contract requires: a lexicon that prices first and checks
 * the engine afterwards has already decided what zero means.
 */
function acmeSim(env: Record<string, string | undefined>): LexiconPlugin["predictBehaviour"] {
  return async (options: PredictBehaviourOptions): Promise<BehaviourResult> => {
    // The one entry point, and the first thing in the method. Calling
    // `assertNoCredentialInOptions` here instead applies one rule of three and
    // drops the other two, so a token past the walk's depth budget and an
    // `awsSecretAccessKey` in `props` both went out with the request. This
    // fixture is the shape #2357, #2359 and #2360 copy, so it has to be right.
    const unsafe = screenBehaviourRequest("acme", options);
    if (unsafe) return unsafe;

    const endpoint = behaviourEngineFrom("acme", env);
    if (!endpoint) return noBehaviourEngineRefusal("acme");
    // The engine answered in each of these three cases; only the first is a
    // problem with the address.
    if (endpoint.value === "fixture://down") {
      return unreachableBehaviourEngineRefusal("acme", endpoint, "connection refused");
    }
    if (endpoint.value === "fixture://broke") {
      return outOfCreditBehaviourEngineRefusal("acme", endpoint, "balance 0.00 USD");
    }
    if (endpoint.value === "fixture://throttled") {
      return overQuotaBehaviourEngineRefusal("acme", endpoint, "5000/5000 predictions this hour");
    }

    const entities: Record<string, PredictedBehaviour> = {};
    const unpredicted: Record<string, { type?: string; reason: "unsupported-kind" }> = {};

    // An entity nothing points at and that points at nothing carries no traffic
    // at the stated level, so its headroom is the engine's baseline. This is the
    // whole reason `edges` is on the request: without it the engine can only
    // price boxes.
    // Degree, not a boolean. A node's load is proportional to how many edges
    // touch it, so removing any one edge moves the figures of both its ends —
    // which is what the conformance probe requires and what "reads the graph"
    // actually means.
    const degree = new Map<string, number>();
    for (const edge of options.edges) {
      degree.set(edge.from, (degree.get(edge.from) ?? 0) + 1);
      degree.set(edge.to, (degree.get(edge.to) ?? 0) + 1);
    }

    for (const name of options.entityNames) {
      const declared = options.entities.get(name);
      if (!declared) continue;
      const modeled = FIXTURE_ENGINE[declared.entityType];
      if (!modeled) {
        // The rule that matters: no model for this kind means say so, never
        // price it at nothing.
        unpredicted[name] = { type: declared.entityType, reason: "unsupported-kind" };
        continue;
      }
      const load = degree.get(name) ?? 0;
      // Busier traffic spends headroom and costs more. Crude, and the point is
      // only that the level is *read*: a fixture that echoed `traffic` and
      // ignored it is exactly what the conformance suite now refuses to pass.
      const intensity = trafficIntensity(options.traffic);
      const spend = (free: number): number =>
        Math.max(0, Math.min(1, 1 - (1 - free) * intensity));
      entities[name] = {
        at: { traffic: options.traffic },
        cost: predictedRate(round(modeled.perHour * intensity), "USD"),
        headroom: {
          cpu: round(spend(modeled.cpu) ** load),
          latency: round(spend(modeled.latency) ** load),
        },
        errorRate: round(Math.min(1, 0.001 * intensity * load)),
        resilience: {
          failure: "one zone lost",
          verdict: name === "db" ? "degrades" : "survives",
          ...(name === "db" ? { note: "single-AZ; a failover costs about 90 seconds" } : {}),
        },
        ...(name === "web"
          ? { rightSize: { suggestion: "t3.small", reason: "62% CPU headroom at the stated level" } }
          : {}),
        provenance: {
          engine: "acme-sim",
          version: FIXTURE_ENGINE_VERSION,
          tolerance: "±15%",
          basis: "modeled",
        },
      };
    }

    return behaviourReport(
      options,
      { engine: "acme-sim", version: FIXTURE_ENGINE_VERSION },
      entities,
      unpredicted,
    );
  };
}

const REACHABLE = { CHANT_BEHAVIOUR_ENGINE: "fixture://acme-sim" };
const CONFIGURED_BUT_DOWN = { CHANT_BEHAVIOUR_ENGINE: "fixture://down" };
const OUT_OF_CREDIT = { CHANT_BEHAVIOUR_ENGINE: "fixture://broke" };
const OVER_QUOTA = { CHANT_BEHAVIOUR_ENGINE: "fixture://throttled" };
const NOTHING_CONFIGURED: Record<string, string | undefined> = {};

describeBehaviourConformance({
  lexicon: "acme-sim (fixture)",
  scenarios: [
    {
      name: "the engine is up",
      declared: [...DECLARED.keys()],
      traffic: "100 rps, p50",
      run: () => acmeSim(REACHABLE)!(REQUEST),
      // The pair the suite varies. Without them it can only ask once, and a
      // lexicon that echoes the traffic level without reading it, and never
      // looks at `edges`, is indistinguishable from one that does the work.
      request: REQUEST,
      predict: (options) => acmeSim(REACHABLE)!(options),
      otherTraffic: "1000 rps, p50",
      expectPredicted: ["web", "db"],
      expectUnpredicted: { queue: "unsupported-kind" },
    },
    {
      name: "nothing names an engine",
      declared: [...DECLARED.keys()],
      run: () => acmeSim(NOTHING_CONFIGURED)!(REQUEST),
      expectRefusal: true,
      expectRefusalCause: "no-engine",
    },
    {
      name: "an engine is named and does not answer",
      declared: [...DECLARED.keys()],
      run: () => acmeSim(CONFIGURED_BUT_DOWN)!(REQUEST),
      expectRefusal: true,
      expectRefusalCause: "engine-unreachable",
    },
    {
      name: "the engine answers and the account is out of credit",
      declared: [...DECLARED.keys()],
      run: () => acmeSim(OUT_OF_CREDIT)!(REQUEST),
      expectRefusal: true,
      expectRefusalCause: "engine-out-of-credit",
    },
    {
      name: "the engine answers and a limit is spent",
      declared: [...DECLARED.keys()],
      run: () => acmeSim(OVER_QUOTA)!(REQUEST),
      expectRefusal: true,
      expectRefusalCause: "engine-over-quota",
    },
  ],
});

describe("a lexicon predicting against the fixture engine (#2356)", () => {
  test("prices the kinds it models, at the traffic level it was asked for", async () => {
    const result = await acmeSim(REACHABLE)!(REQUEST);
    if (isBehaviourRefusalReport(result)) throw new Error("expected a report");

    expect(result.behaviour).toBe("v1");
    expect(result.meta.at.traffic).toBe("100 rps, p50");
    expect(result.entities.web.cost).toEqual({ rate: "per-hour", perHour: 0.0416, currency: "USD" });
    // `web` sits on both edges, so its headroom is spent twice over. The
    // figure moves with the graph, which is the whole point of `edges`.
    expect(result.entities.web.headroom).toEqual({ cpu: 0.3844, latency: 0.1681 });
    expect(result.entities.web.errorRate).toBe(0.002);
    expect(result.entities.web.resilience).toEqual({ failure: "one zone lost", verdict: "survives" });
    expect(result.entities.web.rightSize?.suggestion).toBe("t3.small");
    expect(result.entities.db.resilience.verdict).toBe("degrades");
  });

  test("says unsupported-kind for a kind it has no model for, and never zero", async () => {
    const result = await acmeSim(REACHABLE)!(REQUEST);
    if (isBehaviourRefusalReport(result)) throw new Error("expected a report");

    expect(result.unpredicted?.queue).toEqual({
      type: "AWS::SQS::Queue",
      reason: "unsupported-kind",
    });
    expect(result.entities.queue).toBeUndefined();
  });

  test("every figure names its engine, version, tolerance and basis", async () => {
    const result = await acmeSim(REACHABLE)!(REQUEST);
    if (isBehaviourRefusalReport(result)) throw new Error("expected a report");

    for (const block of Object.values(result.entities)) {
      expect(block.provenance).toEqual({
        engine: "acme-sim",
        version: "1.4.2",
        tolerance: "±15%",
        basis: "modeled",
      });
    }
  });
});

/* -------------------------------------------------------------------------- */
/* The refusal: named, red, and pointing at a variable                        */
/* -------------------------------------------------------------------------- */

describe("an unreachable engine refuses by name (#2356)", () => {
  test("nothing configured is `no-engine`, and the message names the variable to set", async () => {
    const result = await acmeSim(NOTHING_CONFIGURED)!(REQUEST);
    expect(isBehaviourRefusalReport(result)).toBe(true);
    if (!isBehaviourRefusalReport(result)) return;

    expect(result.refusal.cause).toBe("no-engine");
    expect(result.refusal.reason).toContain("CHANT_BEHAVIOUR_ENGINE");
    expect(result.refusal.reason).toContain("CHANT_BEHAVIOUR_ENGINE_ACME");
    expect(result.refusal.reason).toContain("BEHAVIOUR_ENGINE");
    expect(result.refusal.remedy).toBe("Set CHANT_BEHAVIOUR_ENGINE to the engine's address.");
  });

  test("a configured engine that does not answer is `engine-unreachable`, naming which variable pointed at it", async () => {
    const result = await acmeSim(CONFIGURED_BUT_DOWN)!(REQUEST);
    if (!isBehaviourRefusalReport(result)) throw new Error("expected a refusal");

    expect(result.refusal.cause).toBe("engine-unreachable");
    expect(result.refusal.source).toBe("CHANT_BEHAVIOUR_ENGINE");
    expect(result.refusal.reason).toContain("fixture://down");
    expect(result.refusal.reason).toContain("connection refused");
  });

  test("the refusal renders red, with the reason and the remedy", async () => {
    const result = await acmeSim(NOTHING_CONFIGURED)!(REQUEST);
    if (!isBehaviourRefusalReport(result)) throw new Error("expected a refusal");

    const rendered = renderBehaviourRefusal(result.refusal, { color: true });
    expect(rendered.startsWith("\x1b[31m")).toBe(true);
    expect(rendered.endsWith("\x1b[0m")).toBe(true);
    expect(rendered).toContain("behaviour: refused (no-engine)");
    expect(rendered).toContain("CHANT_BEHAVIOUR_ENGINE");
    expect(rendered).toContain("Set CHANT_BEHAVIOUR_ENGINE to the engine's address.");

    // No colour requested, no escapes — the same text a log file gets.
    const plain = renderBehaviourRefusal(result.refusal, { color: false });
    expect(plain).not.toContain("\x1b[");
    expect(plain).toContain("behaviour: refused (no-engine)");
  });

  test("a refusal carries no entities map to be mistaken for an empty estate", async () => {
    const result = await acmeSim(NOTHING_CONFIGURED)!(REQUEST);
    if (!isBehaviourRefusalReport(result)) throw new Error("expected a refusal");

    expect("entities" in result).toBe(false);
    expect("meta" in result).toBe(false);
    expect(isBehaviourResult(result)).toBe(true);
  });
});

describe("an engine that answers and still refuses (#2359)", () => {
  test("an empty account is `engine-out-of-credit`, and the remedy is about money", async () => {
    const result = await acmeSim(OUT_OF_CREDIT)!(REQUEST);
    if (!isBehaviourRefusalReport(result)) throw new Error("expected a refusal");

    expect(result.refusal.cause).toBe("engine-out-of-credit");
    expect(result.refusal.source).toBe("CHANT_BEHAVIOUR_ENGINE");
    expect(result.refusal.reason).toContain("balance 0.00 USD");
    expect(result.refusal.reason).toContain("out of credit");
    expect(result.refusal.remedy).toBe(
      "Add credit to the account behind CHANT_BEHAVIOUR_ENGINE, or repoint it at a funded engine.",
    );
    // The remedy must not send anybody to check a network that is working.
    expect(result.refusal.remedy).not.toMatch(/reachable/i);
  });

  test("a spent limit is `engine-over-quota`, and the remedy is about the limit", async () => {
    const result = await acmeSim(OVER_QUOTA)!(REQUEST);
    if (!isBehaviourRefusalReport(result)) throw new Error("expected a refusal");

    expect(result.refusal.cause).toBe("engine-over-quota");
    expect(result.refusal.reason).toContain("5000/5000 predictions this hour");
    expect(result.refusal.remedy).toBe(
      "Wait for the engine's window to roll over, or raise the limit on the account behind CHANT_BEHAVIOUR_ENGINE.",
    );
    // A spent quota is not an empty account, and telling somebody to pay for
    // one they have already paid for is the wrong instruction.
    expect(result.refusal.remedy).not.toMatch(/credit|fund/i);
  });

  test("the three engine-answered causes are three distinct verdicts", async () => {
    const causes = await Promise.all(
      [CONFIGURED_BUT_DOWN, OUT_OF_CREDIT, OVER_QUOTA].map(async (env) => {
        const result = await acmeSim(env)!(REQUEST);
        if (!isBehaviourRefusalReport(result)) throw new Error("expected a refusal");
        return result.refusal.cause;
      }),
    );
    expect(new Set(causes).size).toBe(3);
    expect(causes).toEqual(["engine-unreachable", "engine-out-of-credit", "engine-over-quota"]);
  });

  test("both render red, naming their own cause", () => {
    const endpoint = { value: "fixture://broke", source: "CHANT_BEHAVIOUR_ENGINE" };
    const broke = renderBehaviourRefusal(
      outOfCreditBehaviourEngineRefusal("acme", endpoint, "balance 0.00 USD").refusal,
      { color: true },
    );
    const throttled = renderBehaviourRefusal(
      overQuotaBehaviourEngineRefusal("acme", endpoint, "5000/5000").refusal,
      { color: true },
    );
    for (const rendered of [broke, throttled]) {
      expect(rendered.startsWith("\x1b[31m")).toBe(true);
      expect(rendered.endsWith("\x1b[0m")).toBe(true);
      expect(rendered).toContain("CHANT_BEHAVIOUR_ENGINE");
    }
    expect(broke).toContain("behaviour: refused (engine-out-of-credit)");
    expect(throttled).toContain("behaviour: refused (engine-over-quota)");
  });
});

/* -------------------------------------------------------------------------- */
/* The request carries edges, not just nodes                                  */
/* -------------------------------------------------------------------------- */

describe("the request is a graph, not a bag of nodes (#2355)", () => {
  test("edges are required — a nodes-only request will not compile", () => {
    // @ts-expect-error the epic's input is "entities ... and the edges between
    // them", so a request without them is not a resource graph.
    const nodesOnly: PredictBehaviourOptions = {
      environment: "prod",
      buildOutput: "/tmp/build",
      entityNames: [...DECLARED.keys()],
      entities: DECLARED,
      traffic: "100 rps, p50",
    };
    expect(nodesOnly).toBeDefined();
  });

  test("edges reach the engine, and change what it says", async () => {
    const connected = await acmeSim(REACHABLE)!(REQUEST);
    const isolated = await acmeSim(REACHABLE)!({ ...REQUEST, edges: [] });
    if (isBehaviourRefusalReport(connected) || isBehaviourRefusalReport(isolated)) {
      throw new Error("expected reports");
    }

    // `web` is on both edges, so it carries load and its headroom is spent
    // accordingly. With no edges the same entity is an island.
    expect(connected.entities.web.headroom).toEqual({ cpu: 0.3844, latency: 0.1681 });
    expect(isolated.entities.web.headroom).toEqual({ cpu: 1, latency: 1 });
    expect(connected.entities.web.errorRate).toBe(0.002);
    expect(isolated.entities.web.errorRate).toBe(0);
  });

  test("edges are `IREdge`, the type both the declared and live paths already produce", () => {
    // Not a structural coincidence: this is the assertion that stops a future
    // change from forking a second edge type for behaviour, which would put a
    // lossy translation on the live side (#2360) and the declared side both.
    const fromGraphIr: IREdge = { from: "web", to: "db", kind: "ref", viaAttr: "dbEndpoint" };
    const request: PredictBehaviourOptions = { ...REQUEST, edges: [fromGraphIr] };
    expect(request.edges[0].kind).toBe("ref");
  });
});

/* -------------------------------------------------------------------------- */
/* Deltas: the invariant lives here, the presentation does not                */
/* -------------------------------------------------------------------------- */

describe("provenance does not survive subtraction (#2358, #2360)", () => {
  const modeled = { engine: "acme-sim", version: "1.4.2", tolerance: "±15%", basis: "modeled" } as const;

  test("same engine, same basis is a delta of like things", () => {
    expect(compareProvenance(modeled, { ...modeled })).toBe("comparable");
    expect(isComparableProvenance(modeled, { ...modeled })).toBe(true);
  });

  test("a modeled figure against a validated one is `mixed-basis`", () => {
    const validated = { ...modeled, basis: "validated" } as const;
    expect(compareProvenance(modeled, validated)).toBe("mixed-basis");
    expect(isComparableProvenance(modeled, validated)).toBe(false);
  });

  test("a different engine, version or tolerance is `mixed-engine`", () => {
    expect(compareProvenance(modeled, { ...modeled, engine: "other-sim" })).toBe("mixed-engine");
    expect(compareProvenance(modeled, { ...modeled, version: "1.5.0" })).toBe("mixed-engine");
    expect(compareProvenance(modeled, { ...modeled, tolerance: "±40%" })).toBe("mixed-engine");
  });

  test("a mismatched engine outranks a mismatched basis", () => {
    // Both differ. The engine verdict is the one that must survive, because
    // two models are not one scale whatever their bases say.
    expect(
      compareProvenance(modeled, { ...modeled, engine: "other-sim", basis: "validated" }),
    ).toBe("mixed-engine");
  });

  test("two entities in one report can be priced by different engines", async () => {
    // Which is why provenance is per entity, and why a consumer summing across
    // a report has to ask before it subtracts.
    const result = await acmeSim(REACHABLE)!(REQUEST);
    if (isBehaviourRefusalReport(result)) throw new Error("expected a report");
    const foreign = { ...result.entities.db.provenance, engine: "other-sim" };
    expect(compareProvenance(result.entities.web.provenance, foreign)).toBe("mixed-engine");
  });

  test("two runs of the same estate at different levels are a mixed-level pair", async () => {
    const quiet = await acmeSim(REACHABLE)!(REQUEST);
    const busy = await acmeSim(REACHABLE)!({ ...REQUEST, traffic: "1000 rps, p50" });
    if (isBehaviourRefusalReport(quiet) || isBehaviourRefusalReport(busy)) {
      throw new Error("expected reports");
    }
    expect(figureMismatches(quiet.entities.web, busy.entities.web)).toEqual(["mixed-level"]);
    // And the figures genuinely moved, so the level was read and not echoed.
    expect(busy.entities.web.cost.perHour).toBeGreaterThan(quiet.entities.web.cost.perHour);
  });

  test("the same estate at two traffic levels is `mixed-level`, not comparable", () => {
    // The gap that mattered: `at` lives on the block, not on provenance, so a
    // provenance-only comparison called 100 rps and 1000 rps a like-for-like
    // delta — and the binding rule is exactly what a consumer follows to draw
    // that delta unmarked.
    const busier: PredictedBehaviour = { ...GOOD, at: { traffic: "1000 rps, p99" } };
    expect(figureMismatches(GOOD, busier)).toEqual(["mixed-level"]);
    expect(isComparableFigure(GOOD, busier)).toBe(false);

    // The provenance-only function still says comparable, and says so in its
    // own doc. This assertion pins that it is the wrong function to call.
    expect(compareProvenance(GOOD.provenance, busier.provenance)).toBe("comparable");
  });

  test("same level, same engine, same basis is comparable", () => {
    expect(compareFigures(GOOD, { ...GOOD }).size).toBe(0);
    expect(isComparableFigure(GOOD, { ...GOOD })).toBe(true);
  });

  test("every mismatching axis is reported, not just the first", () => {
    // The gap: returning one label meant a pair differing in level AND basis
    // reported `mixed-level` and dropped the basis crossing silently, so a
    // consumer captioned it "different traffic level" and showed a
    // modeled-minus-validated difference underneath with nothing said.
    const both: PredictedBehaviour = {
      ...GOOD,
      at: { traffic: "1000 rps" },
      provenance: { ...GOOD.provenance, basis: "validated" },
    };
    expect(figureMismatches(GOOD, both)).toEqual(["mixed-level", "mixed-basis"]);

    const everything: PredictedBehaviour = {
      ...GOOD,
      at: { traffic: "1000 rps" },
      cost: predictedRate(0.04, "EUR"),
      resilience: { failure: "region lost", verdict: "fails" },
      provenance: { ...GOOD.provenance, engine: "other-sim", basis: "validated" },
    };
    expect(figureMismatches(GOOD, everything)).toEqual([
      "mixed-engine",
      "mixed-level",
      "mixed-currency",
      "mixed-basis",
      "mixed-failure",
    ]);
  });

  test("USD minus EUR is not a plain difference", () => {
    // behold already refuses to SUM mixed currencies; permitting them to be
    // DIFFERENCED left this contract laxer than its own consumer. chant
    // converts nothing, so the subtraction is not a number.
    const inEuros: PredictedBehaviour = { ...GOOD, cost: predictedRate(0.0416, "EUR") };
    expect(figureMismatches(GOOD, inEuros)).toEqual(["mixed-currency"]);
    expect(isComparableFigure(GOOD, inEuros)).toBe(false);
  });

  test("two verdicts about two different failures are not a like-for-like delta", () => {
    const regionLost: PredictedBehaviour = {
      ...GOOD,
      resilience: { failure: "region lost", verdict: "fails" },
    };
    expect(figureMismatches(GOOD, regionLost)).toEqual(["mixed-failure"]);
    expect(isComparableFigure(GOOD, regionLost)).toBe(false);
  });

  test("the display order is most fundamental first, and derived from a total witness", () => {
    expect(FIGURE_MISMATCHES).toEqual([
      "mixed-engine",
      "mixed-level",
      "mixed-currency",
      "mixed-basis",
      "mixed-failure",
    ]);

    // The witness is what stops the array drifting from the union. Without it,
    // a sixth axis added to `FigureMismatch` and to `compareFigures` but not to
    // the array is reported by the set and silently dropped by
    // `figureMismatches` — the "a mismatch went unsaid" failure the set return
    // was added to prevent, reappearing in the display path.
    const witness: Record<FigureMismatch, true> = {
      "mixed-engine": true,
      "mixed-level": true,
      "mixed-currency": true,
      "mixed-basis": true,
      "mixed-failure": true,
    };
    expect([...FIGURE_MISMATCHES].sort()).toEqual(Object.keys(witness).sort());
  });

  test("nothing compareFigures can return is dropped by figureMismatches", () => {
    // The two must agree on membership. This is the pairing the witness makes
    // structural; asserting it here keeps the property visible in the suite.
    const everything: PredictedBehaviour = {
      ...GOOD,
      at: { traffic: "1000 rps" },
      cost: predictedRate(0.04, "EUR"),
      resilience: { failure: "region lost", verdict: "fails" },
      provenance: { ...GOOD.provenance, engine: "other-sim", basis: "validated" },
    };
    const set = compareFigures(GOOD, everything);
    expect(figureMismatches(GOOD, everything)).toHaveLength(set.size);
    for (const axis of set) expect(FIGURE_MISMATCHES).toContain(axis);
  });

  test("a report cannot hold entities at different levels in the first place", () => {
    // The other half: `behaviourReport` refuses a block whose `at` disagrees
    // with `meta.at`, so a mixed-level pair can only arise across two reports.
    expect(() =>
      behaviourReport(req(["web", "db"]), STAMP, {
        web: GOOD,
        db: { ...GOOD, at: { traffic: "1000 rps" } },
      }),
    ).toThrow(/One run, one level/);
  });
});

/* -------------------------------------------------------------------------- */
/* Totality, and the 18 rules behold applies on arrival                       */
/* -------------------------------------------------------------------------- */

const STAMP = { engine: "acme-sim", version: "1.4.2" };

/**
 * The half of a request `behaviourReport` reads. Everything that must agree
 * between the request and the report now comes from one object, so a test
 * cannot accidentally construct a disagreement the real path could not.
 */
const req = (
  entityNames: string[],
  traffic = "100 rps, p50",
): Pick<PredictBehaviourOptions, "entityNames" | "traffic" | "edgeCoverage"> => ({
  entityNames,
  traffic,
  edgeCoverage: { verdict: "complete" },
});
const GOOD: PredictedBehaviour = {
  at: { traffic: "100 rps, p50" },
  cost: predictedRate(0.0416, "USD"),
  headroom: { cpu: 0.62, latency: 0.41 },
  errorRate: 0.001,
  resilience: { failure: "one zone lost", verdict: "survives" },
  provenance: { engine: "acme-sim", version: "1.4.2", tolerance: "±15%", basis: "modeled" },
};

describe("totality is enforced, not merely claimed (#2356)", () => {
  test("an entity in neither map is refused, named", () => {
    expect(() => behaviourReport(req(["web", "cache"]), STAMP, { web: GOOD })).toThrow(
      /gave no verdict at all for "cache"/,
    );
  });

  test("the empty report for a non-empty request is refused", () => {
    // The reproduction: `behaviourReport(meta, {}, {})` used to return a
    // well-formed report claiming nothing, because it never saw entityNames.
    expect(() => behaviourReport(req(["web"]), STAMP, {}, {})).toThrow(/gave no verdict at all for "web"/);
  });

  test("an entity in both maps is refused", () => {
    expect(() =>
      behaviourReport(req(["web"]), STAMP, { web: GOOD }, { web: { reason: "unsupported-kind" } }),
    ).toThrow(/both priced and unpriced/);
  });

  test("a figure for something nobody asked about is refused", () => {
    expect(() => behaviourReport(req(["web"]), STAMP, { web: GOOD, ghost: GOOD })).toThrow(
      /returned a figure for "ghost", which was not in entityNames/,
    );
  });

  test("an unpredicted entry with a bogus reason is refused", () => {
    expect(() =>
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      behaviourReport(req(["web"]), STAMP, {}, { web: { reason: "no-credentials" as any } }),
    ).toThrow(/is not one of/);
  });

  test("the check is a check, not a proof — and the doc says so", () => {
    // `BehaviourReport` is a plain interface. A lexicon that hands its own keys
    // back as the asked-for list self-certifies, and a hand-built object skips
    // the constructor entirely. What passing the request buys is that the
    // ordinary route is checked and the check names what is wrong; a consumer
    // needing the guarantee validates on arrival, which is #2358's and #2360's.
    const selfCertified = behaviourReport(req(["web"]), STAMP, { web: GOOD });
    const handBuilt = { ...selfCertified, entities: {} };
    expect(isBehaviourResult(handBuilt)).toBe(true);
    expect(Object.keys(handBuilt.entities)).toEqual([]);
  });

  test("a whole valid report still builds", () => {
    const ok = behaviourReport(req(["web", "queue"]), STAMP, { web: GOOD }, {
      queue: { reason: "unsupported-kind" },
    });
    expect(ok.entities.web).toBe(GOOD);
    expect(ok.unpredicted?.queue.reason).toBe("unsupported-kind");
  });
});

describe("every rule behold applies on arrival is applied here first (#2356)", () => {
  // behold/src/behaviour.ts drops a block failing any of these, so a block
  // chant accepts and behold rejects renders nothing while looking legal.
  const cases: [string, PredictedBehaviour, RegExp][] = [
    ["2 at.traffic empty", { ...GOOD, at: { traffic: "" } }, /at\.traffic is missing/],
    ["3 perHour not finite", { ...GOOD, cost: { rate: "per-hour", perHour: NaN, currency: "USD" } }, /not a finite number/],
    ["4 perHour negative", { ...GOOD, cost: { rate: "per-hour", perHour: -1, currency: "USD" } }, /is negative/],
    ["5 currency empty", { ...GOOD, cost: { rate: "per-hour", perHour: 1, currency: "" } }, /currency is missing/],
    ["7 cpu out of range", { ...GOOD, headroom: { cpu: 1.4 } }, /headroom\.cpu is not a fraction/],
    ["8 latency out of range", { ...GOOD, headroom: { latency: -0.1 } }, /headroom\.latency is not a fraction/],
    ["9 no axis at all", { ...GOOD, headroom: {} as never }, /neither cpu nor latency/],
    ["10 errorRate out of range", { ...GOOD, errorRate: 1.2 }, /errorRate is not a fraction/],
    ["11 failure empty", { ...GOOD, resilience: { failure: "", verdict: "survives" } }, /failure is missing/],
    ["12 bogus verdict", { ...GOOD, resilience: { failure: "one zone lost", verdict: "melts" as never } }, /not survives\/degrades\/fails/],
    ["13 rightSize with no suggestion", { ...GOOD, rightSize: { suggestion: "" } }, /rightSize is present without a suggestion/],
    ["14 engine empty", { ...GOOD, provenance: { ...GOOD.provenance, engine: "" } }, /provenance\.engine is missing/],
    ["15 version empty", { ...GOOD, provenance: { ...GOOD.provenance, version: "" } }, /provenance\.version is missing/],
    ["16 tolerance empty", { ...GOOD, provenance: { ...GOOD.provenance, tolerance: "  " } }, /tolerance is missing/],
    ["17 bogus basis", { ...GOOD, provenance: { ...GOOD.provenance, basis: "estimated" as never } }, /is not modeled\/validated/],
  ];

  for (const [label, block, expected] of cases) {
    test(`rejects ${label}`, () => {
      expect(() => validateBehaviourBlock("web", block)).toThrow(expected);
      expect(() => behaviourReport(req(["web"]), STAMP, { web: block })).toThrow(expected);
    });
  }

  test("a failure that names no failure is rejected, where behold would accept it", () => {
    // `"none"` passes behold's non-empty check and renders a confident verdict
    // about nothing — and this module's own doc already said a verdict with no
    // named failure says nothing.
    for (const word of ["none", "None", "n/a", "unknown", "-", "TBD"]) {
      expect(
        () =>
          validateBehaviourBlock("web", {
            ...GOOD,
            resilience: { failure: word, verdict: "survives" },
          }),
        `${word} was accepted as a failure`,
      ).toThrow(/names no failure/);
    }
    expect(() =>
      validateBehaviourBlock("web", {
        ...GOOD,
        resilience: { failure: "primary database failover", verdict: "degrades" },
      }),
    ).not.toThrow();
  });

  test("a tolerance that states no tolerance is rejected, where behold would accept it", () => {
    // behold takes any non-empty string. The epic asks for the engine's STATED
    // tolerance, and "n/a" passes behold's check while defeating its purpose.
    for (const word of ["n/a", "N/A", "none", "unknown", "-", "TBD"]) {
      expect(
        () => validateBehaviourBlock("web", { ...GOOD, provenance: { ...GOOD.provenance, tolerance: word } }),
        `${word} was accepted`,
      ).toThrow(/states no tolerance/);
    }
    expect(() =>
      validateBehaviourBlock("web", { ...GOOD, provenance: { ...GOOD.provenance, tolerance: "±80%" } }),
    ).not.toThrow();
  });

  test("a block priced at a level the run did not ask for is refused", () => {
    expect(() =>
      behaviourReport(req(["web"]), STAMP, { web: { ...GOOD, at: { traffic: "1000 rps, p99" } } }),
    ).toThrow(/One run, one level/);
  });

  test("report-level fields are checked too", () => {
    expect(() => behaviourReport(req([]), { ...STAMP, engine: "" }, {})).toThrow(/meta\.engine is missing/);
    expect(() => behaviourReport(req([]), { ...STAMP, version: "" }, {})).toThrow(/meta\.version is missing/);
    expect(() => behaviourReport(req([], ""), STAMP, {})).toThrow(/meta\.at\.traffic is missing/);
  });

  test("headroom with no axis will not even compile", () => {
    // @ts-expect-error the union requires cpu or latency. Rule 9 is a type as
    // well as a runtime check, and the runtime check is the JavaScript backstop.
    const empty: BehaviourHeadroom = {};
    expect(empty).toBeDefined();
  });
});

describe("the conformance suite refuses to prove nothing (#2356)", () => {
  const refusalOnly = {
    lexicon: "never-predicts",
    scenarios: [
      { name: "no engine", declared: ["web"], run: () => acmeSim(NOTHING_CONFIGURED)!(REQUEST), expectRefusal: true },
      { name: "engine down", declared: ["web"], run: () => acmeSim(CONFIGURED_BUT_DOWN)!(REQUEST), expectRefusal: true },
    ],
  };

  test("a lexicon that only ever refuses cannot pass by marking everything a refusal", () => {
    expect(behaviourConformanceGaps(refusalOnly)[0]).toBe(
      "every scenario is a refusal — this suite would pass a lexicon that never predicts anything",
    );
  });

  test("a predicting scenario that hides the traffic level it asked for is a gap", () => {
    const noLevel = {
      lexicon: "hides-its-level",
      scenarios: [{ name: "up", declared: ["web"], run: () => acmeSim(REACHABLE)!(REQUEST) }],
    };
    expect(behaviourConformanceGaps(noLevel)).toContain(
      'scenario "up" predicts but does not state the traffic level it requested',
    );
  });

  test("a config the suite can only ask once is a gap — echo is not use", () => {
    // Without `request` and `predict` the suite holds one answer and cannot
    // tell a lexicon that reads `traffic` and `edges` from one that echoes the
    // level and ignores the graph.
    const askOnce = {
      lexicon: "opaque-closure",
      scenarios: [
        {
          name: "up",
          declared: ["web"],
          traffic: "100 rps, p50",
          run: () => acmeSim(REACHABLE)!(REQUEST),
        },
      ],
    };
    expect(behaviourConformanceGaps(askOnce).join(" ")).toMatch(/can only ask once/);
  });

  test("a probe with no second traffic level is a gap — there is no safe default", () => {
    // The old default was `"<level> ×10 (conformance probe)"`, which is a level
    // no engine has agreed to understand. The contract says an engine that
    // cannot understand a level refuses rather than substituting one, so the
    // default failed a contract-correct lexicon for obeying the contract.
    const noSecondLevel = {
      lexicon: "one-level",
      scenarios: [
        {
          name: "up",
          declared: ["web"],
          traffic: "100 rps, p50",
          run: () => acmeSim(REACHABLE)!(REQUEST),
          request: REQUEST,
          predict: (o: PredictBehaviourOptions) => acmeSim(REACHABLE)!(o),
        },
      ],
    };
    expect(behaviourConformanceGaps(noSecondLevel).join(" ")).toMatch(/no safe default/);
  });

  test("a probe whose request cannot exercise the edge probe is a gap", () => {
    // The edge probe drops one edge and requires the answer to change, so a
    // request with fewer than two edges makes it vacuous — and a sibling wiring
    // up a minimal edgeless request would pass "reads the edges it was handed"
    // without the probe ever running.
    const thinGraph = {
      lexicon: "edgeless",
      scenarios: [
        {
          name: "up",
          declared: ["web"],
          traffic: "100 rps, p50",
          otherTraffic: "1000 rps, p50",
          run: () => acmeSim(REACHABLE)!(REQUEST),
          request: { ...REQUEST, edges: [] },
          predict: (o: PredictBehaviourOptions) => acmeSim(REACHABLE)!(o),
        },
      ],
    };
    expect(behaviourConformanceGaps(thinGraph).join(" ")).toMatch(/carries 0 edge\(s\)/);
  });

  test("the fixture's own config has no gaps", () => {
    expect(
      behaviourConformanceGaps({
        lexicon: "acme-sim (fixture)",
        scenarios: [
          {
            name: "up",
            declared: ["web"],
            traffic: "100 rps, p50",
            run: () => acmeSim(REACHABLE)!(REQUEST),
            request: REQUEST,
            predict: (options) => acmeSim(REACHABLE)!(options),
            otherTraffic: "1000 rps, p50",
          },
          { name: "down", declared: ["web"], run: () => acmeSim(CONFIGURED_BUT_DOWN)!(REQUEST), expectRefusal: true },
        ],
      }),
    ).toEqual([]);
  });
});

describe("the lazy lexicon the old suite green-lit (#2356)", () => {
  /**
   * A lexicon that satisfies every type on this contract and is useless: it
   * ignores the traffic level it was handed, ignores the edges, prices
   * everything at zero, reports no headroom axis at all, and states `n/a` for
   * its tolerance. Every one of those passed the conformance suite before the
   * behold rule set landed here, and behold would have dropped every block.
   */
  const lazyBlock = (): PredictedBehaviour =>
    ({
      at: { traffic: "whatever" },
      cost: predictedRate(0, "USD"),
      headroom: {},
      errorRate: 0,
      resilience: { failure: "one zone lost", verdict: "survives" },
      provenance: { engine: "lazy", version: "0", tolerance: "n/a", basis: "modeled" },
    }) as unknown as PredictedBehaviour;

  test("it cannot build a report at all — the validator stops it first", () => {
    expect(() =>
      behaviourReport(req(["web"], "whatever"), { engine: "lazy", version: "0" }, {
        web: lazyBlock(),
      }),
    ).toThrow(/neither cpu nor latency/);
  });

  test("each of its sins is caught by name", () => {
    const withHeadroom = { ...lazyBlock(), headroom: { cpu: 0.5 } };
    expect(() => validateBehaviourBlock("web", withHeadroom)).toThrow(/states no tolerance/);

    const withTolerance = {
      ...withHeadroom,
      provenance: { ...withHeadroom.provenance, tolerance: "±20%" },
    };
    // Zero cost is legal on its own — a free tier is a real answer — so the
    // suite catches an ignored traffic level through `meta.at` instead.
    expect(() => validateBehaviourBlock("web", withTolerance)).not.toThrow();
    expect(() =>
      behaviourReport(req(["web"]), { engine: "lazy", version: "0" }, { web: withTolerance }),
    ).toThrow(/One run, one level/);
  });
});

describe("the second lazy lexicon, which passed 28 of 28 (#2356)", () => {
  /**
   * Sharper than the first. Every field is well-formed and every figure is
   * vacuous: nothing costs anything, nothing is under load, nothing ever fails,
   * the tolerance is a real number that happens to be zero, and the traffic
   * level is echoed back without being read. `edges` and `edgeCoverage` are
   * never opened.
   */
  const lazy = async (options: PredictBehaviourOptions): Promise<BehaviourResult> => {
    const entities: Record<string, PredictedBehaviour> = {};
    for (const name of options.entityNames) {
      entities[name] = {
        at: { traffic: options.traffic },
        cost: predictedRate(0, "USD"),
        headroom: { cpu: 1 },
        errorRate: 0,
        resilience: { failure: "none", verdict: "survives" },
        provenance: { engine: "lazy", version: "1", tolerance: "±0%", basis: "modeled" },
      };
    }
    return behaviourReport(options, { engine: "lazy", version: "1" }, entities);
  };

  test("its `resilience.failure: \"none\"` is now refused at construction", async () => {
    await expect(lazy(REQUEST)).rejects.toThrow(/names no failure/);
  });

  test("even with a real failure named, it answers every traffic level identically", async () => {
    const honest = async (options: PredictBehaviourOptions): Promise<BehaviourResult> => {
      const entities: Record<string, PredictedBehaviour> = {};
      for (const name of options.entityNames) {
        entities[name] = {
          at: { traffic: options.traffic },
          cost: predictedRate(0, "USD"),
          headroom: { cpu: 1 },
          errorRate: 0,
          resilience: { failure: "one zone lost", verdict: "survives" },
          provenance: { engine: "lazy", version: "1", tolerance: "±0%", basis: "modeled" },
        };
      }
      return behaviourReport(options, { engine: "lazy", version: "1" }, entities);
    };

    const quiet = await honest(REQUEST);
    const busy = await honest({ ...REQUEST, traffic: "1000000 rps" });
    if (isBehaviourRefusalReport(quiet) || isBehaviourRefusalReport(busy)) {
      throw new Error("expected reports");
    }
    // The level is echoed and the figures do not move. This is what the
    // conformance suite's two-level probe exists to catch, and a suite holding
    // one opaque `run()` closure could not see it at all.
    expect(busy.meta.at.traffic).toBe("1000000 rps");
    expect(quiet.entities.web.cost.perHour).toBe(busy.entities.web.cost.perHour);
    expect(quiet.entities.web.headroom).toEqual(busy.entities.web.headroom);
  });

  test("removing every edge changes nothing it says", async () => {
    const honest = async (options: PredictBehaviourOptions): Promise<BehaviourResult> => {
      const entities: Record<string, PredictedBehaviour> = {};
      for (const name of options.entityNames) {
        entities[name] = {
          at: { traffic: options.traffic },
          cost: predictedRate(0, "USD"),
          headroom: { cpu: 1 },
          errorRate: 0,
          resilience: { failure: "one zone lost", verdict: "survives" },
          provenance: { engine: "lazy", version: "1", tolerance: "±0%", basis: "modeled" },
        };
      }
      return behaviourReport(options, { engine: "lazy", version: "1" }, entities);
    };
    const withEdges = await honest(REQUEST);
    const without = await honest({ ...REQUEST, edges: [], edgeCoverage: { verdict: "unknown" } });
    if (isBehaviourRefusalReport(withEdges) || isBehaviourRefusalReport(without)) {
      throw new Error("expected reports");
    }
    expect(withEdges.entities.web.headroom).toEqual(without.entities.web.headroom);
  });

  test("the fixture lexicon, by contrast, moves on both axes", async () => {
    const quiet = await acmeSim(REACHABLE)!(REQUEST);
    const busy = await acmeSim(REACHABLE)!({ ...REQUEST, traffic: "1000 rps, p50" });
    const noEdges = await acmeSim(REACHABLE)!({
      ...REQUEST,
      edges: [],
      edgeCoverage: { verdict: "unknown" },
    });
    if (
      isBehaviourRefusalReport(quiet) ||
      isBehaviourRefusalReport(busy) ||
      isBehaviourRefusalReport(noEdges)
    ) {
      throw new Error("expected reports");
    }
    expect(busy.entities.web.cost.perHour).not.toBe(quiet.entities.web.cost.perHour);
    expect(noEdges.entities.web.headroom).not.toEqual(quiet.entities.web.headroom);
  });
});

describe("the dodge lexicon, which passed 16 of 16 (#2356)", () => {
  /**
   * The sharpest of the three. It never reads an edge and prices the estate off
   * the **character count of the traffic label** — and it passed every
   * conformance assertion, including "reads the edges it was handed" and
   * "echoes the edge coverage", by refusing exactly the two probes that would
   * have caught it. Both probes accepted a refusal as an answer.
   */
  const dodge = async (o: PredictBehaviourOptions): Promise<BehaviourResult> => {
    if (o.edges.length === 0 || o.edgeCoverage.verdict === "unknown") {
      return noBehaviourEngineRefusal("dodge");
    }
    const entities: Record<string, PredictedBehaviour> = {};
    for (const name of o.entityNames) {
      entities[name] = {
        at: { traffic: o.traffic },
        // Varies with the traffic *string*, so the level probe is satisfied
        // while nothing about the level is understood.
        cost: predictedRate(o.traffic.length / 100, "USD"),
        headroom: { cpu: 0.5 },
        errorRate: 0.001,
        resilience: { failure: "one zone lost", verdict: "survives" },
        provenance: { engine: "dodge", version: "1", tolerance: "±10%", basis: "modeled" },
      };
    }
    return behaviourReport(o, { engine: "dodge", version: "1" }, entities);
  };

  // The real probe bodies, run against the dodge. These are the assertions the
  // conformance suite makes; a weakening of either shows up here as green.
  test("the coverage probe now complains instead of skipping", async () => {
    expect(await probeEchoesCoverage(REQUEST, dodge)).toEqual([
      'refused a request whose graph is intact and whose only change is an "unknown" coverage ' +
        "verdict (cause: no-engine) — there is nothing here to refuse",
    ]);
  });

  test("the edge probe leaves it nothing to refuse, and catches that nothing changed", async () => {
    // Dropping ONE edge keeps the coverage claim true, so the dodge's refusal
    // condition (`edges.length === 0`) never fires and it has to answer. Its
    // answer is identical, because it never looked at the graph.
    expect(await probeReadsEdges(REQUEST, dodge)).toEqual([
      "removing an edge changed nothing — the graph is being priced as a bag of nodes",
    ]);
  });

  test("it satisfies the traffic probe, which is why the other two must hold", async () => {
    // Pricing off `traffic.length` moves the figures between two levels, so the
    // level probe passes. This is the assertion that shows why the edge and
    // coverage probes carry the weight.
    expect(await probeTrafficLevel(REQUEST, dodge, "1000 rps, p50")).toEqual([]);
  });

  test("the fixture passes all four probes", async () => {
    const predict = (o: PredictBehaviourOptions): Promise<BehaviourResult> =>
      acmeSim(REACHABLE)!(o);
    expect(await probeTrafficLevel(REQUEST, predict, "1000 rps, p50")).toEqual([]);
    expect(await probeReadsEdges(REQUEST, predict)).toEqual([]);
    expect(await probeEdgelessConsistency(REQUEST, predict)).toEqual([]);
    expect(await probeEchoesCoverage(REQUEST, predict)).toEqual([]);
  });
});

describe("the report's account of its own inputs cannot be edited afterwards (#2360)", () => {
  test("edgeCoverage is copied, not aliased", () => {
    // `readonly` is erased at runtime, so assigning the request's object by
    // reference let a caller mutate `unresolvedKinds` after construction and
    // change what the report claimed it was computed over.
    const coverage = {
      verdict: "partial" as const,
      unresolvedKinds: ["AWS::SQS::Queue"],
      dangling: [{ from: "web", path: "vpcId", value: "vpc-1" }],
    };
    const report = behaviourReport({ ...req(["web"]), edgeCoverage: coverage }, STAMP, {
      web: GOOD,
    });
    coverage.unresolvedKinds.push("AWS::SNS::Topic");
    coverage.dangling[0].from = "somewhere-else";

    expect(report.meta.edgeCoverage.unresolvedKinds).toEqual(["AWS::SQS::Queue"]);
    expect(report.meta.edgeCoverage.dangling?.[0].from).toBe("web");
  });

  test("the copy is frozen, so a consumer cannot edit it either", () => {
    const copy = copyEdgeCoverage({ verdict: "partial", unresolvedKinds: ["a"] });
    expect(Object.isFrozen(copy)).toBe(true);
    expect(Object.isFrozen(copy.unresolvedKinds)).toBe(true);
  });
});

/* -------------------------------------------------------------------------- */
/* The envelope guard                                                         */
/* -------------------------------------------------------------------------- */

describe("isBehaviourResult requires an arm, not just the version (#2356)", () => {
  test("a bare discriminant is not a result", () => {
    // It used to pass, then fail isBehaviourRefusalReport, narrow to
    // BehaviourReport, and hand a consumer `undefined` for `entities`.
    expect(isBehaviourResult({ behaviour: "v1" })).toBe(false);
    expect(isBehaviourResult({ behaviour: "v1", entities: {} })).toBe(false);
    expect(isBehaviourResult({ behaviour: "v1", meta: { engine: "x" } })).toBe(false);
  });

  test("both real arms are results", () => {
    expect(isBehaviourResult(behaviourReport(req([]), STAMP, {}))).toBe(true);
    expect(isBehaviourResult(noBehaviourEngineRefusal("acme"))).toBe(true);
  });
});

/* -------------------------------------------------------------------------- */
/* The runtime witness cannot drift from the type                             */
/* -------------------------------------------------------------------------- */

describe("the reason list is derived from the type, not written beside it (#2356)", () => {
  test("every reason the type admits has a runtime witness", () => {
    // The array is Object.keys of a Record keyed by the union, so this cannot
    // fail without the module failing to compile — which is the point. Adding a
    // reason to `UnobservedReason` upstream used to widen this type silently,
    // leaving the guard rejecting a value the type accepted.
    const witness: Record<BehaviourUnpredictedReason, true> = {
      "read-failed": true,
      "no-binding": true,
      "unsupported-kind": true,
      filtered: true,
      "no-engine": true,
      "engine-unreachable": true,
      "engine-out-of-credit": true,
      "engine-over-quota": true,
      "credential-in-request": true,
    };
    expect([...BEHAVIOUR_UNPREDICTED_REASONS].sort()).toEqual(Object.keys(witness).sort());
    for (const reason of Object.keys(witness)) {
      expect(isBehaviourUnpredictedReason(reason), `${reason} has no witness`).toBe(true);
    }
  });

  test("the same construction guards the other two closed sets", () => {
    expect([...BEHAVIOUR_BASES].sort()).toEqual(["modeled", "validated"]);
    expect([...RESILIENCE_VERDICTS].sort()).toEqual(["degrades", "fails", "survives"]);
    expect([...EDGE_COVERAGE_VERDICTS].sort()).toEqual(["complete", "partial", "unknown"]);
  });
});

/* -------------------------------------------------------------------------- */
/* Edge coverage                                                              */
/* -------------------------------------------------------------------------- */

describe("an empty edge list can say which kind of empty it is (#2360)", () => {
  test("coverage is required — `[]` alone is not a statement", () => {
    // @ts-expect-error `edgeCoverage` is required: `edges: []` cannot say
    // whether nothing references anything or nothing could be reconstructed.
    const unstated: PredictBehaviourOptions = { ...REQUEST, edgeCoverage: undefined };
    expect(unstated).toBeDefined();
  });

  test("a partial rebuild carries what it knows it lost", () => {
    const partial: PredictBehaviourOptions = {
      ...REQUEST,
      edges: [],
      edgeCoverage: {
        verdict: "partial",
        dangling: [{ from: "web", path: "vpcId", value: "vpc-0a1b2c3d" }],
        unresolvedKinds: ["AWS::SQS::Queue"],
        containmentEdges: [{ from: "web", to: "subnet-a", kind: "ref" }],
      },
    };
    expect(isEdgeCoverageVerdict(partial.edgeCoverage.verdict)).toBe(true);
    // `from` is the field a flattened string list drops, and it is the one that
    // says which entity's path leaves the estate.
    expect(partial.edgeCoverage.dangling?.[0].from).toBe("web");
    expect(partial.edgeCoverage.dangling?.[0].value).toBe("vpc-0a1b2c3d");
    // Containment is the one an engine needs for "one zone lost" and `edges`
    // will never carry, because chant draws it as a boundary rather than a line.
    expect(partial.edgeCoverage.containmentEdges).toHaveLength(1);
  });

  test("the coverage reaches the reader, not just the engine", () => {
    // Held only on the request it never reached a consumer, so a report's
    // "survives one zone lost" could have been computed over a complete graph
    // or over one whose builder had no idea what it had missed — a faked number
    // the shape rendered invisible, which is the failure the refusal arm exists
    // to prevent, reappearing one level down.
    const report = behaviourReport(
      { ...req(["web"]), edgeCoverage: { verdict: "unknown" } },
      STAMP,
      { web: GOOD },
    );
    expect(report.meta.edgeCoverage.verdict).toBe("unknown");
  });

  test("a `partial` that names no gap is refused", () => {
    // `partial` means "some references are missing"; naming none of them is
    // `unknown` wearing a more confident word.
    expect(() => validateEdgeCoverage({ verdict: "partial" })).toThrow(/names nothing missing/);
    expect(() =>
      behaviourReport({ ...req(["web"]), edgeCoverage: { verdict: "partial" } }, STAMP, {
        web: GOOD,
      }),
    ).toThrow(/names nothing missing/);

    expect(() =>
      validateEdgeCoverage({ verdict: "partial", unresolvedKinds: ["AWS::SQS::Queue"] }),
    ).not.toThrow();
    expect(() =>
      validateEdgeCoverage({
        verdict: "partial",
        dangling: [{ from: "web", path: "vpcId", value: "vpc-1" }],
      }),
    ).not.toThrow();
  });

  test("`complete` with a dangling reference is legal, and must stay so", () => {
    // A dangling ref points outside the named set by definition — a
    // cross-account VPC, another team's resource — so a builder can have found
    // every edge among the entities it was asked about and still have
    // references leaving the estate. Nobody should "fix" this.
    expect(() =>
      validateEdgeCoverage({
        verdict: "complete",
        dangling: [{ from: "web", path: "vpcId", value: "vpc-elsewhere" }],
      }),
    ).not.toThrow();
  });

  test("a bogus verdict is refused", () => {
    // @ts-expect-error "probably" is not one of the three.
    expect(() => validateEdgeCoverage({ verdict: "probably" })).toThrow(/is not complete/);
  });

  test("`unknown` is available for a builder that cannot say", () => {
    const opaque: PredictBehaviourOptions = {
      ...REQUEST,
      edges: [],
      edgeCoverage: { verdict: "unknown" },
    };
    expect(opaque.edgeCoverage.verdict).toBe("unknown");
  });
});

/* -------------------------------------------------------------------------- */
/* Nothing in a refusal publishes a credential                                */
/* -------------------------------------------------------------------------- */

describe("a refusal never prints the engine's credentials (#2358 posts these publicly)", () => {
  const env = {
    CHANT_BEHAVIOUR_ENGINE: "https://svc:s3cr3t@engine.internal/predict?key=abc123&sig=zzz",
  };

  test("userinfo and the query string are gone from the reason and the remedy", () => {
    const endpoint = behaviourEngineFrom("acme", env)!;
    const refusal = unreachableBehaviourEngineRefusal("acme", endpoint, "ECONNREFUSED").refusal;
    for (const text of [refusal.reason, refusal.remedy]) {
      expect(text, "the password leaked").not.toContain("s3cr3t");
      expect(text, "the userinfo leaked").not.toContain("svc:");
      expect(text, "a query token leaked").not.toContain("abc123");
      expect(text, "a signature leaked").not.toContain("zzz");
    }
    // The host survives, because a refusal naming no address cannot be acted on.
    expect(refusal.reason).toContain("engine.internal");
  });

  test("the credit and quota refusals redact the same way", () => {
    const endpoint = behaviourEngineFrom("acme", env)!;
    for (const refusal of [
      outOfCreditBehaviourEngineRefusal("acme", endpoint, "balance 0.00").refusal,
      overQuotaBehaviourEngineRefusal("acme", endpoint, "5000/5000").refusal,
    ]) {
      expect(refusal.reason).not.toContain("s3cr3t");
      expect(refusal.reason).not.toContain("abc123");
      expect(refusal.remedy).not.toContain("s3cr3t");
    }
  });

  test("engine-supplied detail is bounded and scrubbed", () => {
    const endpoint = behaviourEngineFrom("acme", env)!;
    const chatty =
      "quota exceeded; see https://billing.acme.example/accounts/9?token=glpat-abcdef123456 " +
      "for details ".repeat(60);
    const reason = overQuotaBehaviourEngineRefusal("acme", endpoint, chatty).refusal.reason;
    expect(reason).not.toContain("glpat-abcdef123456");
    expect(reason).not.toContain("/accounts/9");
    expect(reason.length).toBeLessThan(chatty.length);
  });

  test("an OAuth token in the fragment is gone", () => {
    // The implicit flow puts the access token after the `#`, where it never
    // reaches a server and where the URL parse was not looking.
    const redacted = redactEngineAddress(
      "https://engine.internal/predict#access_token=Zm9vYmFyYmF6cXV4&state=1",
    );
    expect(redacted).not.toContain("Zm9vYmFyYmF6cXV4");
    expect(redacted).not.toContain("access_token");
    expect(redacted).toContain("engine.internal");
  });

  test("the query marker lands beside the fragment marker, not inside it", () => {
    const redacted = redactEngineAddress("https://engine.internal/p?key=abc#access_token=xyz");
    expect(redacted).not.toContain("abc");
    expect(redacted).not.toContain("xyz");
    // Wire order: query then fragment. Appending `?[redacted]` to a string that
    // still carried a fragment used to bury it inside the fragment.
    expect(redacted.indexOf("?")).toBeLessThan(redacted.indexOf("#"));
  });

  test("an inline flag value on a PATH command is blanked", () => {
    // An engine may be a command rather than a URL, and a command carries its
    // credential as an argument — which the URL parse cannot see and which
    // `redactCredentialMaterial` reads as neither an env value nor a known
    // token prefix.
    for (const address of [
      "engine-cmd --token=hunter2plain --at 100rps",
      "engine-cmd --api-key hunter2plain",
      "engine-cmd -p hunter2plain",
      "engine-cmd --client-secret=hunter2plain",
    ]) {
      expect(redactEngineAddress(address), address).not.toContain("hunter2plain");
      expect(redactEngineAddress(address)).toContain("engine-cmd");
    }
  });

  test("a path-segment token survives, and the doc says so", () => {
    // Documented rather than fixed: nothing here can tell a token in a path
    // segment from a resource id, and an earlier version of the doc claimed
    // pass 3 caught it. This test pins the honest behaviour so the claim cannot
    // quietly come back.
    const opaque = "https://engine.internal/predict/Zm9vYmFyYmF6cXV4/go";
    expect(redactEngineAddress(opaque)).toContain("Zm9vYmFyYmF6cXV4");
  });

  test("a socket path or a bare command is left readable", () => {
    const local = behaviourEngineFrom("acme", { CHANT_BEHAVIOUR_ENGINE: "/var/run/acme.sock" })!;
    expect(unreachableBehaviourEngineRefusal("acme", local, "no such file").refusal.reason).toContain(
      "/var/run/acme.sock",
    );
    expect(redactEngineAddress("acme-sim")).toBe("acme-sim");
  });
});

describe("the engine variable chain (#2356)", () => {
  test("resolves most specific first, and names which variable won", () => {
    const env = {
      CHANT_BEHAVIOUR_ENGINE_ACME: "fixture://scoped",
      CHANT_BEHAVIOUR_ENGINE: "fixture://chant-wide",
      BEHAVIOUR_ENGINE: "fixture://bare",
    };
    expect(behaviourEngineFrom("acme", env)).toEqual({
      value: "fixture://scoped",
      source: "CHANT_BEHAVIOUR_ENGINE_ACME",
    });
    expect(behaviourEngineFrom("acme", { ...env, CHANT_BEHAVIOUR_ENGINE_ACME: "" })).toEqual({
      value: "fixture://chant-wide",
      source: "CHANT_BEHAVIOUR_ENGINE",
    });
    expect(behaviourEngineFrom("acme", { BEHAVIOUR_ENGINE: " fixture://bare " })).toEqual({
      value: "fixture://bare",
      source: "BEHAVIOUR_ENGINE",
    });
    expect(behaviourEngineFrom("acme", {})).toBeUndefined();
  });

  test("the scoped variable is the lexicon name, upper-cased and underscored", () => {
    expect(behaviourEngineVariables("gcp-config-connector")[0]).toBe(
      "CHANT_BEHAVIOUR_ENGINE_GCP_CONFIG_CONNECTOR",
    );
  });

  test("the refusal message quotes the chain it just walked", () => {
    const message = noBehaviourEngineMessage("acme");
    for (const variable of behaviourEngineVariables("acme")) {
      expect(message, `the message does not name ${variable}`).toContain(variable);
    }
  });
});

/* -------------------------------------------------------------------------- */
/* Rule 1: a prediction is never presented as a bill                          */
/* -------------------------------------------------------------------------- */

describe("rule 1 — a prediction cannot be shaped like a bill (#2356)", () => {
  test("every cost carries the per-hour discriminant", () => {
    expect(predictedRate(0.0416, "USD").rate).toBe("per-hour");
  });

  test("a billing record cannot be assigned where a predicted rate is wanted", () => {
    interface LineItem {
      amount: number;
      currency: string;
      periodStart: string;
      periodEnd: string;
      invoiceId: string;
    }
    const charged: LineItem = {
      amount: 30.37,
      currency: "USD",
      periodStart: "2026-08-01",
      periodEnd: "2026-08-31",
      invoiceId: "INV-4471",
    };
    // @ts-expect-error a charge for an elapsed period is not a rate for an
    // imagined hour: `rate: "per-hour"` is missing and `amount` is not `perHour`.
    const asPrediction: PredictedRate = charged;
    expect(asPrediction).toBeDefined();
  });

  test("a figure cannot be built without the traffic level it answers", () => {
    // @ts-expect-error `at` is required — a number with no stated question is
    // the number most likely to be quoted as money owed.
    const noLevel: PredictedBehaviour = {
      cost: predictedRate(0.0416, "USD"),
      headroom: { cpu: 0.62 },
      errorRate: 0.001,
      resilience: { failure: "one zone lost", verdict: "survives" },
      provenance: { engine: "acme-sim", version: "1.4.2", tolerance: "±15%", basis: "modeled" },
    };
    expect(noLevel).toBeDefined();
  });

  test("a report has nowhere to put a billing period or an account", () => {
    const asStatement = behaviourReport(
      req([]),
      {
        engine: "acme-sim",
        version: "1.4.2",
        // @ts-expect-error the envelope models a run, not a statement: there is
        // no account to bill and no period that elapsed.
        accountId: "123456789012",
        periodStart: "2026-08-01",
      },
      {},
    );
    expect(asStatement).toBeDefined();
  });
});

/* -------------------------------------------------------------------------- */
/* Rule 2: a missing engine is a named refusal, never a zeroed result         */
/* -------------------------------------------------------------------------- */

describe("rule 2 — the refusal arm has no figures on it (#2356)", () => {
  test("a refusal report cannot carry entities", () => {
    const refusal = noBehaviourEngineRefusal("acme");
    // @ts-expect-error `BehaviourRefusalReport` has no `entities` member, so
    // "zero everything and carry on" is not a shape this contract can express.
    refusal.entities = {};
    expect(refusal.refusal.cause).toBe("no-engine");
  });

  test("`no-engine` and `engine-unreachable` are distinguishable verdicts", () => {
    expect(isBehaviourUnpredictedReason("no-engine")).toBe(true);
    expect(isBehaviourUnpredictedReason("engine-unreachable")).toBe(true);
    expect(noBehaviourEngineRefusal("acme").refusal.cause).not.toBe(
      unreachableBehaviourEngineRefusal("acme", { value: "x", source: "BEHAVIOUR_ENGINE" }, "down")
        .refusal.cause,
    );
  });
});

/* -------------------------------------------------------------------------- */
/* Rule 3: the engine never sees a credential                                 */
/* -------------------------------------------------------------------------- */

describe("rule 3 — no credential can reach the engine (#2356)", () => {
  test("a credential field is a compile error, by name", () => {
    // @ts-expect-error `token` is declared `?: never`.
    const withToken: PredictBehaviourOptions = { ...REQUEST, token: "glpat-xxxx" };
    // @ts-expect-error `credentials` is declared `?: never`.
    const withCredentials: PredictBehaviourOptions = { ...REQUEST, credentials: { key: "AKIA" } };
    // @ts-expect-error `apiKey` is declared `?: never`.
    const withApiKey: PredictBehaviourOptions = { ...REQUEST, apiKey: "sk-live-1" };
    // @ts-expect-error `sessionToken` is declared `?: never`.
    const withSession: PredictBehaviourOptions = { ...REQUEST, sessionToken: "FwoGZ" };
    expect([withToken, withCredentials, withApiKey, withSession]).toHaveLength(4);
  });

  test("a name nobody thought of is rejected too, by the excess-property check", () => {
    // @ts-expect-error the options are sealed: an unlisted key is a compile
    // error whether or not it is on the credential list.
    const smuggled: PredictBehaviourOptions = { ...REQUEST, acmeSimSigningSecret: "hunter2" };
    expect(smuggled).toBeDefined();
  });

  test("the fixture lexicon screens with the entry point, not the value-only half", async () => {
    // F1: `assertNoCredentialInOptions` applies one rule of three. A lexicon
    // calling it — as this fixture did, and as the docs page told #2357 to —
    // sends the request anyway on a key-name hit and on a walk-depth hit.
    const leaky = new Map(DECLARED);
    leaky.set("db", {
      entityType: "AWS::RDS::DBInstance",
      props: { awsSecretAccessKey: "wJalrXUtnFEMIK7MDENGbPxRfiCYEXAMPLEKEY" },
    });
    const onName = await acmeSim(REACHABLE)!({ ...REQUEST, entities: leaky });
    expect(isBehaviourRefusalReport(onName), "a key-name hit reached the engine").toBe(true);
    if (isBehaviourRefusalReport(onName)) {
      expect(onName.refusal.cause).toBe("credential-in-request");
      expect(onName.refusal.reason).toContain("awsSecretAccessKey");
    }

    // And the depth case, which `assertNoCredentialInOptions` also drops.
    let deep: unknown = "leaf";
    for (let i = 0; i < 40; i++) deep = { nested: deep };
    const nested = new Map(DECLARED);
    nested.set("web", { entityType: "AWS::EC2::Instance", props: { deep } });
    const onDepth = await acmeSim(REACHABLE)!({ ...REQUEST, entities: nested });
    expect(isBehaviourRefusalReport(onDepth), "an unread subtree reached the engine").toBe(true);

    // A live token still throws, because that arm is a stop rather than a
    // degradation — the split the two functions exist to keep.
    const token = new Map(DECLARED);
    token.set("web", {
      entityType: "AWS::EC2::Instance",
      props: { note: "ghp_abcdefghijklmnop" },
    });
    await expect(acmeSim(REACHABLE)!({ ...REQUEST, entities: token })).rejects.toThrow(
      /a GitHub token/,
    );
  });

  test("the depth budget leaves room for a real property tree", () => {
    // `options → entities → .get(name) → props` spends three levels before a
    // declared property is reached, and a k8s workload tree
    // (`spec.template.spec.containers[].env[].valueFrom.secretKeyRef.key`) runs
    // to a dozen on its own. Exceeding the budget now refuses, so a budget set
    // too low refuses real estates rather than protecting them.
    let tree: unknown = { key: "config-value" };
    for (const level of ["secretKeyRef", "valueFrom", "env", "containers", "spec", "template", "spec"]) {
      tree = { [level]: [tree] };
    }
    const k8s = new Map(DECLARED);
    k8s.set("web", { entityType: "AWS::EC2::Instance", props: tree as Record<string, unknown> });
    expect(findCredentialsInOptions({ ...REQUEST, entities: k8s })).toEqual([]);
  });

  test("a suspicious field name refuses, and does NOT throw", () => {
    // The blast radius matters. Throwing is the whole-lexicon failure per
    // lexicon.ts, and the name arm is a heuristic: one `tags: { author: … }`
    // anywhere in an estate used to kill the entire overlay with a stack trace,
    // which is precisely the failure constraint 2 was written against.
    for (const key of ["token", "credentials", "apiKey", "privateKey", "authorization"]) {
      const options = { ...REQUEST, [key]: "a-value-long-enough-to-suspect" };
      expect(() => assertNoCredentialInOptions(options), `${key} threw`).not.toThrow();
      const refusal = screenBehaviourRequest("acme", options);
      expect(refusal, `${key} was not caught`).toBeDefined();
      expect(refusal!.refusal.cause).toBe("credential-in-request");
      expect(refusal!.refusal.reason).toContain(`("${key}")`);
    }
    expect(screenBehaviourRequest("acme", REQUEST)).toBeUndefined();
  });

  test("a key nobody listed is caught too — casing, separators and all", () => {
    // The reproduction that broke the old 14-name list. Every one of these
    // compiles clean through a widened variable.
    const smuggled: Record<string, string> = {
      xApiKey: "sk-live-DEADBEEF",
      Authorization: "Bearer abcdefghijklmnop",
      pat: "glpat-zzzzzzzz",
      "x-api-key": "whatever-value-here",
      clientSecret: "s3cr3t-value-here",
      refreshToken: "r3fr3sh-value-here",
      awsSecretAccessKey: "wJalrXUtnFEMIK7MDENG",
      cookie: "session=abcdefgh",
    };
    for (const [key, value] of Object.entries(smuggled)) {
      const found = findCredentialsInOptions({ ...REQUEST, [key]: value });
      expect(found.length, `${key} was not caught`).toBeGreaterThan(0);
    }
  });

  test("a credential in `props` is caught — the channel no type can see", () => {
    // Props come straight out of the build. A lexicon surfacing a connection
    // string puts one here without deciding to, which is the realistic leak.
    const leaky = new Map(DECLARED);
    leaky.set("db", {
      entityType: "AWS::RDS::DBInstance",
      props: { awsSecretAccessKey: "wJalrXUtnFEMIK7MDENGbPxRfiCYEXAMPLEKEY" },
    });
    const named = screenBehaviourRequest("acme", { ...REQUEST, entities: leaky });
    expect(named?.refusal.reason).toMatch(/credential-shaped field name \("awsSecretAccessKey"\)/);

    // A password in a URL is the value arm, so it throws rather than refusing.
    const urlCreds = new Map(DECLARED);
    urlCreds.set("db", {
      entityType: "AWS::RDS::DBInstance",
      props: { connection: "postgres://app:hunter2@db.internal:5432/prod" },
    });
    expect(() => assertNoCredentialInOptions({ ...REQUEST, entities: urlCreds })).toThrow(
      /a password in a URL's userinfo/,
    );
  });

  test("a scheme-less DSN is caught — `new URL()` will not parse one", () => {
    const dsn = new Map(DECLARED);
    dsn.set("db", {
      entityType: "AWS::RDS::DBInstance",
      props: { dsn: "app:hunter2@db.internal:5432/prod" },
    });
    expect(() => assertNoCredentialInOptions({ ...REQUEST, entities: dsn })).toThrow(
      /a password in a URL's userinfo/,
    );
  });

  test("a Map's keys are read, not just its values", () => {
    // An env block is a Map as often as an object, and walking only values
    // missed `DB_PASSWORD` entirely.
    const env = new Map(DECLARED);
    env.set("web", {
      entityType: "AWS::EC2::Instance",
      props: { env: new Map([["DB_PASSWORD", "hunter2plain"]]) },
    });
    const refusal = screenBehaviourRequest("acme", { ...REQUEST, entities: env });
    expect(refusal?.refusal.reason).toMatch(/DB_PASSWORD/);
  });

  test("a Set's contents are read — `Object.entries` on a Set is empty", () => {
    const set = new Map(DECLARED);
    set.set("web", {
      entityType: "AWS::EC2::Instance",
      props: { allowed: new Set(["glpat-abcdef123456"]) },
    });
    expect(() => assertNoCredentialInOptions({ ...REQUEST, entities: set })).toThrow(
      /a GitLab personal access token/,
    );
  });

  test("a structure deeper than the walk reads is reported, not passed in silence", () => {
    let deep: unknown = "leaf";
    for (let i = 0; i < 40; i++) deep = { nested: deep };
    const nested = new Map(DECLARED);
    nested.set("web", { entityType: "AWS::EC2::Instance", props: { deep } });
    const found = findCredentialsInOptions({ ...REQUEST, entities: nested });
    expect(found.some((f) => f.rule === "walk-depth")).toBe(true);
    // And it refuses rather than proceeding as though the request were checked.
    expect(screenBehaviourRequest("acme", { ...REQUEST, entities: nested })).toBeDefined();
  });

  test("a credential on an edge field is caught", () => {
    expect(() =>
      assertNoCredentialInOptions({
        ...REQUEST,
        edges: [{ from: "web", to: "db", kind: "ref", viaAttr: "token=glpat-abcdef123456" }],
      }),
    ).toThrow(/a GitLab personal access token/);
  });

  test("a credential-shaped value is caught wherever it sits, whatever the key", () => {
    const shapes: Record<string, string> = {
      note: "ghp_abcdefghijklmnop",
      label: "AKIAIOSFODNN7EXAMPLE",
      hint: "xoxb-1234-5678-abcdefg",
      blob: "-----BEGIN RSA PRIVATE KEY-----\nMIIE\n-----END RSA PRIVATE KEY-----",
      jwt: "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abc",
    };
    for (const [key, value] of Object.entries(shapes)) {
      const props = new Map(DECLARED);
      props.set("web", { entityType: "AWS::EC2::Instance", props: { [key]: value } });
      expect(
        () => assertNoCredentialInOptions({ ...REQUEST, entities: props }),
        `${key} was not caught`,
      ).toThrow(/behaviour engine is never handed a credential/);
    }
  });

  test("the guard refuses none of this repo's own generated property keys", () => {
    // THE regression guard for the name arm, and the reason it can be trusted
    // enough to keep. An earlier version matched `SECRET|TOKEN|PASSWORD|AUTH`
    // as a bare substring of the key and refused 406 aws keys, 173 azure, 89
    // gcp and 7 k8s — `imagePullSecrets`, `secretName`, `secretKeyRef`,
    // `ClientToken`, `CertificateAuthorityArn`, `authorizedNetworks`,
    // `passwordPolicy`, `authMode`, `oauthScopes` — every one of them ordinary
    // in real infrastructure, and every one of them fatal, because the guard
    // threw. #2357, #2359 and #2360 all build requests from these props.
    //
    // Read from the generated `.d.ts` rather than the registry JSON: the JSON
    // yields 81 names for aws and would prove nothing.
    const counts: Record<string, number> = {};
    for (const lexicon of ["aws", "azure", "gcp", "k8s"]) {
      const dts = join(__dirname, "../../../lexicons", lexicon, "src/generated/index.d.ts");
      const keys = new Set<string>();
      for (const m of readFileSync(dts, "utf8").matchAll(
        /^\s+(?:readonly\s+)?([A-Za-z_]\w*)\??\s*:/gm,
      )) {
        keys.add(m[1]);
      }
      counts[lexicon] = keys.size;

      const props: Record<string, unknown> = {};
      for (const key of keys) props[key] = "ok";
      const entities = new Map(DECLARED);
      entities.set("web", { entityType: "AWS::EC2::Instance", props });

      const refused = findCredentialsInOptions({ ...REQUEST, entities }).map((f) => f.path);
      expect(refused, `${lexicon} keys refused with a benign value`).toEqual([]);
    }

    // A floor, not a pin: this catches a regeneration that SHRINKS the key set
    // (or an extractor that quietly stops matching), which is the way this test
    // goes vacuous. A regeneration that adds names is not caught here and does
    // not need to be — the zero-refusals assertion above already covers every
    // name present, however many there are.
    expect(counts.aws).toBeGreaterThan(13000);
    expect(counts.azure).toBeGreaterThan(4900);
    expect(counts.gcp).toBeGreaterThan(3300);
    expect(counts.k8s).toBeGreaterThan(290);
  });

  test("the reference-by-name family is carved out, by suffix and by name", () => {
    // Named explicitly so the carve-out list cannot be trimmed without a red.
    // Every one holds a pointer, an id, a duration or a scope list, never a
    // secret — and every one is long enough to trip the length gate.
    const benign = "a-perfectly-ordinary-value";
    for (const key of [
      "imagePullSecrets",
      "secretName",
      "secretRef",
      "secretKeyRef",
      "ClientToken",
      "AdminPasswordSecretArn",
      "APIKeyId",
      "AccessTokenId",
      "AccessTokenValidity",
      "ActorTokenScopes",
      "CertificateAuthorityArn",
      "authorizedNetworks",
      "passwordPolicy",
      "authMode",
      "oauthScopes",
      "automountServiceAccountToken",
    ]) {
      const entities = new Map(DECLARED);
      entities.set("web", { entityType: "AWS::EC2::Instance", props: { [key]: benign } });
      expect(
        findCredentialsInOptions({ ...REQUEST, entities }),
        `${key} was refused`,
      ).toEqual([]);
    }
  });

  test("a genuine credential field holding a reference is not refused; holding a token is", () => {
    // `AdminPassword` on AWS::DirectoryService::MicrosoftAD is a real
    // credential field. In chant source it holds a resolve-expression or a
    // `{ $ref }`, and refusing those would refuse the correct way to write it.
    const ref = new Map(DECLARED);
    ref.set("web", {
      entityType: "AWS::EC2::Instance",
      props: {
        AdminPassword: "{{resolve:secretsmanager:prod/ad:SecretString:password}}",
        AccountPassword: { $ref: "vault.adminPassword" },
        ADDomainJoinPassword: "${secrets.domainJoin}",
      },
    });
    expect(findCredentialsInOptions({ ...REQUEST, entities: ref })).toEqual([]);

    // A live value in the same field is still caught, by the value arm.
    const live = new Map(DECLARED);
    live.set("web", {
      entityType: "AWS::EC2::Instance",
      props: { AdminPassword: "ghp_abcdefghijklmnop" },
    });
    expect(() => assertNoCredentialInOptions({ ...REQUEST, entities: live })).toThrow(
      /a GitHub token/,
    );
  });

  test("a non-string never trips the name arm", () => {
    // `{ tokenCount: 4096 }`, `{ AccessControlAllowCredentials: true }`, and a
    // list of config objects whose parent key contains `auth`.
    const typed = new Map(DECLARED);
    typed.set("web", {
      entityType: "AWS::EC2::Instance",
      props: {
        tokenCount: 4096,
        AccessControlAllowCredentials: true,
        AdditionalAuthenticationProviders: [{ AuthenticationType: "AWS_IAM" }],
        tags: { author: "alex" },
      },
    });
    expect(findCredentialsInOptions({ ...REQUEST, entities: typed })).toEqual([]);
  });

  test("ordinary build output is not refused — ids, ARNs and digests pass", () => {
    // The other half of the bargain. There is no entropy scoring on purpose:
    // this walks build output, and a heuristic refusing these would refuse real
    // projects rather than protect them.
    const ordinary = new Map(DECLARED);
    ordinary.set("web", {
      entityType: "AWS::EC2::Instance",
      props: {
        arn: "arn:aws:ec2:us-east-1:123456789012:instance/i-0abcd1234ef567890",
        digest: "sha256:9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08",
        accountId: "123456789012",
        subnet: "subnet-0a1b2c3d4e5f6a7b8",
        url: "https://api.internal.example.com/v1/things?page=2",
      },
    });
    expect(() => assertNoCredentialInOptions({ ...REQUEST, entities: ordinary })).not.toThrow();
  });

  test("the lexicon itself refuses a smuggled credential before it resolves an engine", async () => {
    await expect(
      // Only a double cast gets a credential this far, which is the type doing
      // its job; the runtime guard is what catches a caller with no types at all.
      acmeSim(REACHABLE)!({ ...REQUEST, token: "glpat-xxxx" } as unknown as PredictBehaviourOptions),
    ).rejects.toThrow(/never handed a credential/);
  });
});

/* -------------------------------------------------------------------------- */
/* Rule 4: provenance on every number, with a closed basis                    */
/* -------------------------------------------------------------------------- */

describe("rule 4 — provenance, and a basis from a closed set (#2356)", () => {
  test("a prediction cannot be built without provenance", () => {
    // @ts-expect-error `provenance` is required.
    const unattributed: PredictedBehaviour = {
      at: { traffic: "100 rps, p50" },
      cost: predictedRate(0.0416, "USD"),
      headroom: { cpu: 0.62 },
      errorRate: 0.001,
      resilience: { failure: "one zone lost", verdict: "survives" },
    };
    expect(unattributed).toBeDefined();
  });

  test("provenance cannot be built without a basis", () => {
    // @ts-expect-error `basis` is required — "which engine" is not enough, the
    // reader has to know whether a bill was ever involved.
    const noBasis: PredictedBehaviour["provenance"] = {
      engine: "acme-sim",
      version: "1.4.2",
      tolerance: "±15%",
    };
    expect(noBasis).toBeDefined();
  });

  test("the basis is a closed enum, not a free string", () => {
    const invented: PredictedBehaviour["provenance"] = {
      engine: "acme-sim",
      version: "1.4.2",
      tolerance: "±15%",
      // @ts-expect-error "estimated" is not one of the two. A third word would
      // let a figure dodge the question the enum exists to force.
      basis: "estimated",
    };
    expect(invented).toBeDefined();

    expect(BEHAVIOUR_BASES).toEqual(["modeled", "validated"]);
    expect(isBehaviourBasis("modeled")).toBe(true);
    expect(isBehaviourBasis("validated")).toBe(true);
    expect(isBehaviourBasis("estimated")).toBe(false);
    expect(isBehaviourBasis("guessed")).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */
/* The tri-state                                                              */
/* -------------------------------------------------------------------------- */

describe("the behaviour tri-state (#2356)", () => {
  test("the reasons are the observation set minus no-credentials, plus the engine and request states", () => {
    expect([...BEHAVIOUR_UNPREDICTED_REASONS].sort()).toEqual([
      "credential-in-request",
      "engine-out-of-credit",
      "engine-over-quota",
      "engine-unreachable",
      "filtered",
      "no-binding",
      "no-engine",
      "read-failed",
      "unsupported-kind",
    ]);
  });

  test("each engine state is separately switchable", () => {
    for (const reason of [
      "no-engine",
      "engine-unreachable",
      "engine-out-of-credit",
      "engine-over-quota",
    ]) {
      expect(isBehaviourUnpredictedReason(reason), `${reason} is not a reason`).toBe(true);
    }
  });

  test("`no-credentials` is not a behaviour reason — the engine is never handed one", () => {
    expect(isBehaviourUnpredictedReason("no-credentials")).toBe(false);
    // @ts-expect-error and it is not assignable either, so a lexicon cannot
    // send an operator hunting for a variable this contract forbids.
    const borrowed: (typeof BEHAVIOUR_UNPREDICTED_REASONS)[number] = "no-credentials";
    expect(borrowed).toBe("no-credentials");
  });

  test("the four shared verdicts keep the spelling `UnobservedReason` gave them", () => {
    for (const reason of ["read-failed", "no-binding", "unsupported-kind", "filtered"]) {
      expect(isBehaviourUnpredictedReason(reason)).toBe(true);
    }
  });
});
