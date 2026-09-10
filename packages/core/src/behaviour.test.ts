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
import { describeBehaviourConformance, behaviourConformanceGaps } from "@intentius/chant-test-utils";
import type { LexiconPlugin } from "./lexicon";
import type { IREdge } from "./graph-ir";
import {
  BEHAVIOUR_BASES,
  BEHAVIOUR_UNPREDICTED_REASONS,
  assertNoCredentialInOptions,
  behaviourEngineFrom,
  behaviourEngineVariables,
  behaviourReport,
  compareFigures,
  compareProvenance,
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
    assertNoCredentialInOptions(options);

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
    const connected = new Set<string>();
    for (const edge of options.edges) {
      connected.add(edge.from);
      connected.add(edge.to);
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
      const load = connected.has(name) ? 1 : 0;
      entities[name] = {
        at: { traffic: options.traffic },
        cost: predictedRate(modeled.perHour, "USD"),
        headroom: {
          cpu: load ? modeled.cpu : 1,
          latency: load ? modeled.latency : 1,
        },
        errorRate: load ? 0.001 : 0,
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
      {
        engine: "acme-sim",
        version: FIXTURE_ENGINE_VERSION,
        at: { traffic: options.traffic },
      },
      options.entityNames,
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
    expect(result.entities.web.headroom).toEqual({ cpu: 0.62, latency: 0.41 });
    expect(result.entities.web.errorRate).toBe(0.001);
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
    expect(connected.entities.web.headroom).toEqual({ cpu: 0.62, latency: 0.41 });
    expect(isolated.entities.web.headroom).toEqual({ cpu: 1, latency: 1 });
    expect(connected.entities.web.errorRate).toBe(0.001);
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

  test("the same estate at two traffic levels is `mixed-level`, not comparable", () => {
    // The gap that mattered: `at` lives on the block, not on provenance, so a
    // provenance-only comparison called 100 rps and 1000 rps a like-for-like
    // delta — and the binding rule is exactly what a consumer follows to draw
    // that delta unmarked.
    const busier: PredictedBehaviour = { ...GOOD, at: { traffic: "1000 rps, p99" } };
    expect(compareFigures(GOOD, busier)).toBe("mixed-level");
    expect(isComparableFigure(GOOD, busier)).toBe(false);

    // The provenance-only function still says comparable, and says so in its
    // own doc. This assertion pins that it is the wrong function to call.
    expect(compareProvenance(GOOD.provenance, busier.provenance)).toBe("comparable");
  });

  test("same level, same engine, same basis is comparable", () => {
    expect(compareFigures(GOOD, { ...GOOD })).toBe("comparable");
    expect(isComparableFigure(GOOD, { ...GOOD })).toBe(true);
  });

  test("a mismatched engine outranks a mismatched level, which outranks a mismatched basis", () => {
    const otherEngine: PredictedBehaviour = {
      ...GOOD,
      at: { traffic: "1000 rps" },
      provenance: { ...GOOD.provenance, engine: "other-sim", basis: "validated" },
    };
    expect(compareFigures(GOOD, otherEngine)).toBe("mixed-engine");

    const otherLevel: PredictedBehaviour = {
      ...GOOD,
      at: { traffic: "1000 rps" },
      provenance: { ...GOOD.provenance, basis: "validated" },
    };
    expect(compareFigures(GOOD, otherLevel)).toBe("mixed-level");

    const otherBasis: PredictedBehaviour = {
      ...GOOD,
      provenance: { ...GOOD.provenance, basis: "validated" },
    };
    expect(compareFigures(GOOD, otherBasis)).toBe("mixed-basis");
  });

  test("a report cannot hold entities at different levels in the first place", () => {
    // The other half: `behaviourReport` refuses a block whose `at` disagrees
    // with `meta.at`, so a mixed-level pair can only arise across two reports.
    expect(() =>
      behaviourReport(META, ["web", "db"], {
        web: GOOD,
        db: { ...GOOD, at: { traffic: "1000 rps" } },
      }),
    ).toThrow(/One run, one level/);
  });
});

/* -------------------------------------------------------------------------- */
/* Totality, and the 18 rules behold applies on arrival                       */
/* -------------------------------------------------------------------------- */

const META = { engine: "acme-sim", version: "1.4.2", at: { traffic: "100 rps, p50" } };
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
    expect(() => behaviourReport(META, ["web", "cache"], { web: GOOD })).toThrow(
      /gave no verdict at all for "cache"/,
    );
  });

  test("the empty report for a non-empty request is refused", () => {
    // The reproduction: `behaviourReport(meta, {}, {})` used to return a
    // well-formed report claiming nothing, because it never saw entityNames.
    expect(() => behaviourReport(META, ["web"], {}, {})).toThrow(/gave no verdict at all for "web"/);
  });

  test("an entity in both maps is refused", () => {
    expect(() =>
      behaviourReport(META, ["web"], { web: GOOD }, { web: { reason: "unsupported-kind" } }),
    ).toThrow(/both priced and unpriced/);
  });

  test("a figure for something nobody asked about is refused", () => {
    expect(() => behaviourReport(META, ["web"], { web: GOOD, ghost: GOOD })).toThrow(
      /returned a figure for "ghost", which was not in entityNames/,
    );
  });

  test("an unpredicted entry with a bogus reason is refused", () => {
    expect(() =>
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      behaviourReport(META, ["web"], {}, { web: { reason: "no-credentials" as any } }),
    ).toThrow(/is not one of/);
  });

  test("a whole valid report still builds", () => {
    const ok = behaviourReport(META, ["web", "queue"], { web: GOOD }, {
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
      expect(() => behaviourReport(META, ["web"], { web: block })).toThrow(expected);
    });
  }

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
      behaviourReport(META, ["web"], { web: { ...GOOD, at: { traffic: "1000 rps, p99" } } }),
    ).toThrow(/One run, one level/);
  });

  test("report-level fields are checked too", () => {
    expect(() => behaviourReport({ ...META, engine: "" }, [], {})).toThrow(/meta\.engine is missing/);
    expect(() => behaviourReport({ ...META, version: "" }, [], {})).toThrow(/meta\.version is missing/);
    expect(() => behaviourReport({ ...META, at: { traffic: "" } }, [], {})).toThrow(/meta\.at\.traffic is missing/);
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
    expect(behaviourConformanceGaps(refusalOnly)).toEqual([
      "every scenario is a refusal — this suite would pass a lexicon that never predicts anything",
    ]);
  });

  test("a predicting scenario that hides the traffic level it asked for is a gap", () => {
    const noLevel = {
      lexicon: "hides-its-level",
      scenarios: [{ name: "up", declared: ["web"], run: () => acmeSim(REACHABLE)!(REQUEST) }],
    };
    expect(behaviourConformanceGaps(noLevel)).toEqual([
      'scenario "up" predicts but does not state the traffic level it requested',
    ]);
  });

  test("the fixture's own config has no gaps", () => {
    expect(
      behaviourConformanceGaps({
        lexicon: "acme-sim (fixture)",
        scenarios: [
          { name: "up", declared: ["web"], traffic: "100 rps, p50", run: () => acmeSim(REACHABLE)!(REQUEST) },
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
      behaviourReport(
        { engine: "lazy", version: "0", at: { traffic: "whatever" } },
        ["web"],
        { web: lazyBlock() },
      ),
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
      behaviourReport(
        { engine: "lazy", version: "0", at: { traffic: "100 rps, p50" } },
        ["web"],
        { web: withTolerance },
      ),
    ).toThrow(/One run, one level/);
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
    expect(isBehaviourResult({ behaviour: "v1", meta: META })).toBe(false);
  });

  test("both real arms are results", () => {
    expect(isBehaviourResult(behaviourReport(META, [], {}))).toBe(true);
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
        dangling: ["vpc-0a1b2c3d"],
        unresolvedKinds: ["AWS::SQS::Queue"],
        containment: [{ from: "web", to: "subnet-a", kind: "ref" }],
      },
    };
    expect(isEdgeCoverageVerdict(partial.edgeCoverage.verdict)).toBe(true);
    expect(partial.edgeCoverage.dangling).toEqual(["vpc-0a1b2c3d"]);
    // Containment is the one an engine needs for "one zone lost" and `edges`
    // will never carry, because chant draws it as a boundary rather than a line.
    expect(partial.edgeCoverage.containment).toHaveLength(1);
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
      {
        engine: "acme-sim",
        version: "1.4.2",
        at: { traffic: "100 rps, p50" },
        // @ts-expect-error the envelope models a run, not a statement: there is
        // no account to bill and no period that elapsed.
        accountId: "123456789012",
        periodStart: "2026-08-01",
      },
      [],
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

  test("a credential arriving from JavaScript is refused at runtime, naming the field", () => {
    for (const key of ["token", "credentials", "apiKey", "privateKey", "authorization"]) {
      expect(() => assertNoCredentialInOptions({ ...REQUEST, [key]: "x" })).toThrow(
        new RegExp(`credential-shaped field name \\("${key}"\\)`),
      );
    }
    expect(() => assertNoCredentialInOptions(REQUEST)).not.toThrow();
  });

  test("a key nobody listed is caught too — casing, separators and all", () => {
    // The reproduction that broke the old 14-name list. Every one of these
    // compiles clean through a widened variable, and every one is a credential.
    const smuggled: Record<string, unknown> = {
      xApiKey: "sk-live-DEADBEEF",
      Authorization: "Bearer abc",
      pat: "glpat-zzz",
      "x-api-key": "whatever",
      clientSecret: "s",
      refreshToken: "r",
      awsSecretAccessKey: "a",
      cookie: "session=1",
    };
    for (const [key, value] of Object.entries(smuggled)) {
      expect(
        () => assertNoCredentialInOptions({ ...REQUEST, [key]: value }),
        `${key} was not caught`,
      ).toThrow(/behaviour engine is never handed a credential/);
    }
  });

  test("a credential in `props` is caught — the channel no type can see", () => {
    // Props come straight out of the build. A lexicon surfacing a connection
    // string puts one here without deciding to, which is the realistic leak.
    const leaky = new Map(DECLARED);
    leaky.set("db", {
      entityType: "AWS::RDS::DBInstance",
      props: { awsSecretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY" },
    });
    expect(() => assertNoCredentialInOptions({ ...REQUEST, entities: leaky })).toThrow(
      /credential-shaped field name \("awsSecretAccessKey"\)/,
    );

    const urlCreds = new Map(DECLARED);
    urlCreds.set("db", {
      entityType: "AWS::RDS::DBInstance",
      props: { connection: "postgres://app:hunter2@db.internal:5432/prod" },
    });
    expect(() => assertNoCredentialInOptions({ ...REQUEST, entities: urlCreds })).toThrow(
      /a password in a URL's userinfo/,
    );
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
  test("the reasons are the observation set minus no-credentials, plus the four engine states", () => {
    expect([...BEHAVIOUR_UNPREDICTED_REASONS].sort()).toEqual([
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
