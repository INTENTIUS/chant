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
import { describeBehaviourConformance } from "@intentius/chant-test-utils";
import type { LexiconPlugin } from "./lexicon";
import {
  BEHAVIOUR_BASES,
  BEHAVIOUR_UNPREDICTED_REASONS,
  assertNoCredentialInOptions,
  behaviourEngineFrom,
  behaviourEngineVariables,
  behaviourReport,
  isBehaviourBasis,
  isBehaviourRefusalReport,
  isBehaviourResult,
  isBehaviourUnpredictedReason,
  noBehaviourEngineMessage,
  noBehaviourEngineRefusal,
  predictedRate,
  renderBehaviourRefusal,
  unreachableBehaviourEngineRefusal,
  type BehaviourResult,
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

const REQUEST: PredictBehaviourOptions = {
  environment: "prod",
  buildOutput: "/tmp/build",
  entityNames: [...DECLARED.keys()],
  entities: DECLARED,
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
    if (endpoint.value !== "fixture://acme-sim") {
      return unreachableBehaviourEngineRefusal("acme", endpoint, "connection refused");
    }

    const entities: Record<string, PredictedBehaviour> = {};
    const unpredicted: Record<string, { type?: string; reason: "unsupported-kind" }> = {};

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
      entities[name] = {
        at: { traffic: options.traffic },
        cost: predictedRate(modeled.perHour, "USD"),
        headroom: { cpu: modeled.cpu, latency: modeled.latency },
        errorRate: 0.001,
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
      entities,
      unpredicted,
    );
  };
}

const REACHABLE = { CHANT_BEHAVIOUR_ENGINE: "fixture://acme-sim" };
const CONFIGURED_BUT_DOWN = { CHANT_BEHAVIOUR_ENGINE: "https://acme-sim.invalid" };
const NOTHING_CONFIGURED: Record<string, string | undefined> = {};

describeBehaviourConformance({
  lexicon: "acme-sim (fixture)",
  scenarios: [
    {
      name: "the engine is up",
      declared: [...DECLARED.keys()],
      run: () => acmeSim(REACHABLE)!(REQUEST),
      expectPredicted: ["web", "db"],
      expectUnpredicted: { queue: "unsupported-kind" },
    },
    {
      name: "nothing names an engine",
      declared: [...DECLARED.keys()],
      run: () => acmeSim(NOTHING_CONFIGURED)!(REQUEST),
      expectRefusal: true,
    },
    {
      name: "an engine is named and does not answer",
      declared: [...DECLARED.keys()],
      run: () => acmeSim(CONFIGURED_BUT_DOWN)!(REQUEST),
      expectRefusal: true,
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
    expect(result.refusal.reason).toContain("https://acme-sim.invalid");
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
        new RegExp(`passed "${key}" in its options`),
      );
    }
    expect(() => assertNoCredentialInOptions(REQUEST)).not.toThrow();
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
  test("the reasons are the observation set minus no-credentials, plus the two engine states", () => {
    expect([...BEHAVIOUR_UNPREDICTED_REASONS].sort()).toEqual([
      "engine-unreachable",
      "filtered",
      "no-binding",
      "no-engine",
      "read-failed",
      "unsupported-kind",
    ]);
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
