/**
 * augur's `predictBehaviour()`, held to the contract (#2357, contract #2356).
 *
 * Three halves, and the first is not this file's own work: `packages/test-utils`'s
 * `describeBehaviourConformance` is the shared suite every predicting lexicon
 * runs, and the point of running it is that augur is checked by the same code
 * every later lexicon will be checked by rather than by assertions written to
 * fit it.
 *
 * The suite's four probes are the ones that need a request it can vary, so the
 * scenario below supplies `request`, `predict` and `otherTraffic`. That request
 * is a compact estate rather than the example project's: `probeReadsEdges`
 * drops the last edge and requires the answer to move, so the probe request
 * needs its edges to fall between entities the coverage table maps. The example
 * project's thirty-two edges are mostly between boundaries augur withholds,
 * which would make the probe vacuous. The example gets its own end-to-end test
 * further down, and the golden request is `./request.test.ts`'s.
 *
 * The rest is what is augur's rather than the contract's: the credential screen
 * running *first*, the mapping producing a per-entity decline that names the
 * kind, an engine that loses a node being reported rather than hidden, and the
 * address chain.
 */

import { describe, expect, test } from "vitest";
import {
  describeBehaviourConformance,
  behaviourConformanceGaps,
  probeReadsEdges,
  probeTrafficLevel,
} from "@intentius/chant-test-utils";
import {
  behaviourWireRefusal,
  isBehaviourRefusalReport,
  unreachableBehaviourEngineRefusal,
  type BehaviourResult,
  type BehaviourWireCause,
  type PredictBehaviourOptions,
} from "@intentius/chant/behaviour";
import type { IREdge } from "@intentius/chant/graph-ir";
import { createAugurPredict } from "./predict-behaviour";
import { defaultConnect, parseEngineAnswer, type EngineConnect } from "./engine";
import { fixtureEngine, FIXTURE_ENGINE_NAME, FIXTURE_ENGINE_VERSION } from "./__fixtures__/fixture-engine";
import { exampleRequestOptions } from "./__fixtures__/example-request";

/* -------------------------------------------------------------------------- */
/* The probe estate                                                           */
/* -------------------------------------------------------------------------- */

/**
 * Five entities across all three states the coverage table has: two mapped and
 * priced, one mapped and priced, one declared unmapped, one the table has never
 * seen. Both roads to `unsupported-kind` are exercised, because the whole value
 * of writing the second table down is that the two say different things.
 */
const DECLARED = new Map<string, { entityType: string; props: Record<string, unknown> }>([
  ["web", { entityType: "AWS::EC2::Instance", props: { InstanceType: "t3.medium" } }],
  ["db", { entityType: "AWS::RDS::DBInstance", props: { DBInstanceClass: "db.t3.medium" } }],
  ["orders", { entityType: "AWS::SQS::Queue", props: { QueueName: "orders" } }],
  ["appRole", { entityType: "AWS::IAM::Role", props: { RoleName: "app" } }],
  ["gadget", { entityType: "Acme::Widget::Thing", props: {} }],
]);

/**
 * `web` writes the database and reads the queue, and the database drains the
 * queue: three edges, all between mapped nodes.
 *
 * Three rather than two, and the order matters. `probeReadsEdges` drops the
 * **last** edge and requires the answer to move. With two edges, dropping the
 * last one disconnects `orders` entirely — so an engine keying on a
 * connected/not-connected boolean would move that node's figures and pass a
 * probe it should fail. Removing `db → orders` leaves both of its ends still
 * connected, so only an engine reading edge *degree* answers differently.
 */
const EDGES: IREdge[] = [
  { from: "web", to: "db", kind: "ref", viaAttr: "dbEndpoint", toAttr: "Endpoint_Address" },
  { from: "web", to: "orders", kind: "ref", viaAttr: "queueUrl", toAttr: "QueueUrl" },
  { from: "db", to: "orders", kind: "ref", viaAttr: "deadLetterQueue", toAttr: "Arn" },
];

const REQUEST: PredictBehaviourOptions = {
  environment: "prod",
  buildOutput: "/tmp/build",
  entityNames: [...DECLARED.keys()],
  entities: DECLARED,
  region: "us-east-1",
  traffic: "100 rps, p50",
  edges: EDGES,
  edgeCoverage: { verdict: "complete" },
};

const CONNECTED: EngineConnect = () => fixtureEngine();
const UP = { CHANT_BEHAVIOUR_ENGINE: "augur-fixture" };
const NOTHING: Record<string, string | undefined> = {};

const predictWith = (env: Record<string, string | undefined>, connect: EngineConnect = CONNECTED) =>
  createAugurPredict({ env, connect });

const up = predictWith(UP);

/** The endpoint the fixture stands at, for a refusal that names it. */
const FIXTURE_ENDPOINT = { value: "augur-fixture", source: "CHANT_BEHAVIOUR_ENGINE" };

/**
 * An engine that answered and refused, in each of the three shapes it can —
 * built by the contract's one mapping, the way a transport builds it.
 */
const refusing = (cause: BehaviourWireCause, detail: string) =>
  predictWith(UP, () => fixtureEngine({ refuse: behaviourWireRefusal("augur", FIXTURE_ENDPOINT, cause, detail) }));

describeBehaviourConformance({
  lexicon: "augur",
  scenarios: [
    {
      name: "the engine is up",
      declared: [...DECLARED.keys()],
      traffic: "100 rps, p50",
      run: () => up(REQUEST),
      request: REQUEST,
      predict: up,
      otherTraffic: "1000 rps, p99",
      expectPredicted: ["web", "db", "orders"],
      expectUnpredicted: { appRole: "unsupported-kind", gadget: "unsupported-kind" },
    },
    {
      name: "nothing names an engine",
      declared: [...DECLARED.keys()],
      run: () => predictWith(NOTHING)(REQUEST),
      expectRefusal: true,
      expectRefusalCause: "no-engine",
    },
    {
      name: "an engine is named and does not answer",
      declared: [...DECLARED.keys()],
      run: () => refusing("engine-unreachable", "connection refused")(REQUEST),
      expectRefusal: true,
      expectRefusalCause: "engine-unreachable",
    },
    {
      name: "the engine answers and the account is out of credit",
      declared: [...DECLARED.keys()],
      run: () => refusing("engine-out-of-credit", "balance 0.00 USD")(REQUEST),
      expectRefusal: true,
      expectRefusalCause: "engine-out-of-credit",
    },
    {
      name: "the engine answers and a limit is spent",
      declared: [...DECLARED.keys()],
      run: () => refusing("engine-over-quota", "5000/5000 predictions this hour")(REQUEST),
      expectRefusal: true,
      expectRefusalCause: "engine-over-quota",
    },
    {
      name: "the address is one no transport speaks",
      declared: [...DECLARED.keys()],
      run: () =>
        createAugurPredict({
          env: { CHANT_BEHAVIOUR_ENGINE: "grpc://engine.internal:9000" },
          connect: defaultConnect,
        })(REQUEST),
      expectRefusal: true,
      expectRefusalCause: "engine-unreachable",
    },
    {
      name: "the address is a URL and no variable names a token",
      declared: [...DECLARED.keys()],
      run: () =>
        createAugurPredict({
          env: { CHANT_BEHAVIOUR_ENGINE: "https://engine.example/predict" },
          connect: defaultConnect,
        })(REQUEST),
      expectRefusal: true,
      expectRefusalCause: "no-engine",
    },
  ],
});

describe("the suite is configured to prove something", () => {
  test("the probe request carries enough edges for every probe to run", () => {
    // `behaviourConformanceGaps` reports a probe request with fewer than two
    // edges as a stated gap, since the edge probe drops one and needs the
    // remainder to still be a graph.
    expect(REQUEST.edges.length).toBeGreaterThanOrEqual(2);
    expect(
      behaviourConformanceGaps({
        lexicon: "augur",
        scenarios: [
          {
            name: "the engine is up",
            declared: [...DECLARED.keys()],
            traffic: "100 rps, p50",
            run: () => up(REQUEST),
            request: REQUEST,
            predict: up,
            otherTraffic: "1000 rps, p99",
          },
        ],
      }),
    ).toEqual([]);
  });

  test("the probes pass when run directly, not only inside the suite", async () => {
    expect(await probeTrafficLevel(REQUEST, up, "1000 rps, p99")).toEqual([]);
    expect(await probeReadsEdges(REQUEST, up)).toEqual([]);
  });
});

/* -------------------------------------------------------------------------- */
/* The coverage table, as a per-entity verdict                                */
/* -------------------------------------------------------------------------- */

describe("a kind with no engine equivalent is declined by name (#2357)", () => {
  test("a declared-unmapped kind names the kind and the reason it carries no rate", async () => {
    const result = await up(REQUEST);
    if (isBehaviourRefusalReport(result)) throw new Error("expected a report");
    const role = result.unpredicted?.appRole;
    expect(role?.reason).toBe("unsupported-kind");
    expect(role?.type).toBe("AWS::IAM::Role");
    expect(role?.detail).toContain("AWS::IAM::Role");
    expect(role?.detail).toContain("declared unmapped by the augur coverage table");
    expect(role?.detail).toContain("a role is a grant");
  });

  test("a kind the table has never seen says so, and where to add the row", async () => {
    const result = await up(REQUEST);
    if (isBehaviourRefusalReport(result)) throw new Error("expected a report");
    const gadget = result.unpredicted?.gadget;
    expect(gadget?.reason).toBe("unsupported-kind");
    expect(gadget?.detail).toContain("Acme::Widget::Thing");
    expect(gadget?.detail).toContain("neither mapped to an engine kind nor declared unmapped");
    expect(gadget?.detail).toContain("lexicons/augur/src/mapping.ts");
  });

  test("neither is dropped, and neither is priced at zero", async () => {
    const result = await up(REQUEST);
    if (isBehaviourRefusalReport(result)) throw new Error("expected a report");
    // The whole tri-state, in one assertion: five asked about, three priced,
    // two declined, nothing in neither map and nothing in both.
    expect(Object.keys(result.entities).sort()).toEqual(["db", "orders", "web"]);
    expect(Object.keys(result.unpredicted ?? {}).sort()).toEqual(["appRole", "gadget"]);
    expect(Object.prototype.hasOwnProperty.call(result.entities, "appRole")).toBe(false);
  });

  test("the report echoes the coverage claim it was given, and the level it was asked at", async () => {
    const result = await up({ ...REQUEST, edgeCoverage: { verdict: "unknown" } });
    if (isBehaviourRefusalReport(result)) throw new Error("expected a report");
    expect(result.meta.edgeCoverage.verdict).toBe("unknown");
    expect(result.meta.at.traffic).toBe("100 rps, p50");
    expect(result.meta.engine).toBe(FIXTURE_ENGINE_NAME);
    expect(result.meta.version).toBe(FIXTURE_ENGINE_VERSION);
  });
});

/* -------------------------------------------------------------------------- */
/* Rule 3: the screen runs first, and it is the whole screen                  */
/* -------------------------------------------------------------------------- */

describe("no credential reaches the engine (#2356 rule 3)", () => {
  const withProps = (props: Record<string, unknown>): PredictBehaviourOptions => ({
    ...REQUEST,
    entityNames: ["leaky"],
    entities: new Map([["leaky", { entityType: "AWS::EC2::Instance", props }]]),
    edges: [],
    edgeCoverage: { verdict: "unknown" },
  });

  test("a credential-shaped value anywhere in props stops the request", async () => {
    // The value arm throws, which per `lexicon.ts` fails the whole lexicon. A
    // live token bound for a third party is a stop rather than a degradation.
    await expect(up(withProps({ note: "ghp_0123456789abcdef0123456789abcdef0123" }))).rejects.toThrow(
      /predictBehaviour was passed/,
    );
  });

  test("a merely suspicious field name refuses, and does not throw", async () => {
    // The name arm is a heuristic, and the old contract threw on it — one
    // `tags: { author: "…" }` took a whole overlay down with a stack trace.
    const result = await up(withProps({ apiKey: "not-actually-a-secret" }));
    expect(isBehaviourRefusalReport(result)).toBe(true);
    if (!isBehaviourRefusalReport(result)) return;
    expect(result.refusal.cause).toBe("credential-in-request");
    expect(result.refusal.reason).toContain("apiKey");
  });

  test("the screen runs before the engine is resolved, so a leak is not masked by a missing engine", async () => {
    // The ordering assertion. With no engine configured AND a credential in
    // the request, `no-engine` would be a correct-looking answer that hid the
    // leak — and would keep hiding it until somebody set the variable.
    const result = await predictWith(NOTHING)(withProps({ apiKey: "not-actually-a-secret" }));
    expect(isBehaviourRefusalReport(result)).toBe(true);
    if (!isBehaviourRefusalReport(result)) return;
    expect(result.refusal.cause).toBe("credential-in-request");
  });

  test("the whole screen, not the value arm alone", async () => {
    // `assertNoCredentialInOptions` filters to `value-shape` and drops the
    // key-name and walk-depth rules — review finding F1 on #2365. A lexicon
    // calling it instead of `screenBehaviourRequest` sends the request above.
    const result = await up(withProps({ apiKey: "not-actually-a-secret" }));
    expect(isBehaviourRefusalReport(result)).toBe(true);
  });

  test("an ordinary ARN, a digest and an SSM reference are not refused", async () => {
    // The guard is a denylist of known formats with no entropy scoring, and it
    // walks build output full of exactly these. Refusing them would refuse real
    // projects rather than protect them.
    const result = await up(
      withProps({
        RoleArn: "arn:aws:iam::123456789012:role/app",
        ImageDigest: "sha256:1e5f0c4a5b6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f9012345678901234",
        MasterUserPassword: "{{resolve:ssm:/checkout/dev/db-password}}",
      }),
    );
    expect(isBehaviourRefusalReport(result)).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */
/* An engine that answers badly                                               */
/* -------------------------------------------------------------------------- */

describe("an engine that answers about the wrong estate", () => {
  test("a node the engine declines is `read-failed`, naming the engine's reason", async () => {
    const predict = predictWith(UP, () => fixtureEngine({ decline: { db: "no price model for db.t3.medium" } }));
    const result = await predict(REQUEST);
    if (isBehaviourRefusalReport(result)) throw new Error("expected a report");
    expect(result.unpredicted?.db?.reason).toBe("read-failed");
    expect(result.unpredicted?.db?.detail).toContain("no price model for db.t3.medium");
    expect(result.entities.db).toBeUndefined();
  });

  test("a node the engine loses is reported, not rendered as an estate one node smaller", async () => {
    const predict = predictWith(UP, () => fixtureEngine({ lose: ["orders"] }));
    const result = await predict(REQUEST);
    if (isBehaviourRefusalReport(result)) throw new Error("expected a report");
    expect(result.unpredicted?.orders?.reason).toBe("read-failed");
    expect(result.unpredicted?.orders?.detail).toContain("names it in neither its figures nor its declined list");
  });
});

/* -------------------------------------------------------------------------- */
/* The address chain                                                          */
/* -------------------------------------------------------------------------- */

describe("the engine address chain", () => {
  test("the lexicon-scoped variable wins over the chant-wide one", async () => {
    const seen: string[] = [];
    const connect: EngineConnect = (endpoint) => {
      seen.push(`${endpoint.source}=${endpoint.value}`);
      return fixtureEngine();
    };
    await createAugurPredict({
      env: {
        CHANT_BEHAVIOUR_ENGINE_AUGUR: "augur-engine",
        CHANT_BEHAVIOUR_ENGINE: "everything-else",
        BEHAVIOUR_ENGINE: "the-fallback",
      },
      connect,
    })(REQUEST);
    expect(seen).toEqual(["CHANT_BEHAVIOUR_ENGINE_AUGUR=augur-engine"]);
  });

  test("no engine at all names the variable to set, and draws nothing", async () => {
    const result = await predictWith(NOTHING)(REQUEST);
    if (!isBehaviourRefusalReport(result)) throw new Error("expected a refusal");
    expect(result.refusal.reason).toContain("CHANT_BEHAVIOUR_ENGINE");
    expect(Object.prototype.hasOwnProperty.call(result, "entities")).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(result, "meta")).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */
/* The example project, end to end                                            */
/* -------------------------------------------------------------------------- */

describe("the example estate, predicted end to end (#2357)", () => {
  test("prices what the table maps and declines the rest, each by name", async () => {
    const options = await exampleRequestOptions();
    const result: BehaviourResult = await up(options);
    if (isBehaviourRefusalReport(result)) throw new Error("expected a report");

    expect(Object.keys(result.entities).sort()).toEqual([
      "arrivalsQueue",
      "arrièreQueue",
      "databaseDb",
      "receipts",
    ]);
    const declined = result.unpredicted ?? {};
    expect(declined.networkVpc?.reason).toBe("unsupported-kind");
    expect(declined.networkVpc?.detail).toContain("AWS::EC2::VPC");
    expect(declined.networkNatGateway?.detail).toContain("per-gigabyte meter");

    // Every entity the build produced has a verdict. `behaviourReport` refuses
    // a report that leaves one in neither map, so this passing is the contract
    // enforcing itself rather than this assertion doing the work.
    const accounted = new Set([...Object.keys(result.entities), ...Object.keys(declined)]);
    expect(options.entityNames.filter((n) => !accounted.has(n))).toEqual([]);
  });

  test("the report states the partial coverage it was given, not a tidier claim", async () => {
    const result = await up(await exampleRequestOptions());
    if (isBehaviourRefusalReport(result)) throw new Error("expected a report");
    expect(result.meta.edgeCoverage.verdict).toBe("partial");
    expect(result.meta.edgeCoverage.unresolvedKinds).toEqual(["AWS::EC2::VPC", "AWS::EC2::Subnet"]);
  });
});

describe("an entity named after a prototype member (D5)", () => {
  // `entities`/`unpredicted` were plain `{}` and `answer.figures` comes from
  // `JSON.parse`, so `figures["constructor"]` was a function rather than
  // `undefined` and the guard missed it, while `unpredicted["__proto__"] = …`
  // set a prototype instead of adding a key and the entry vanished — which
  // `behaviourReport`'s totality check then reported as a lost entity.
  const hazards = ["constructor", "toString", "__proto__", "hasOwnProperty"];

  for (const name of hazards) {
    test(`prices "${name}" without throwing`, async () => {
      const declared = new Map([[name, { entityType: "AWS::EC2::Instance", props: { InstanceType: "t3.medium" } }]]);
      const result = await up({
        ...REQUEST,
        entityNames: [name],
        entities: declared,
        edges: [],
        edgeCoverage: { verdict: "unknown" },
      });
      if (isBehaviourRefusalReport(result)) throw new Error("expected a report");
      expect(Object.prototype.hasOwnProperty.call(result.entities, name)).toBe(true);
    });

    test(`declines "${name}" without throwing when its kind has no row`, async () => {
      const declared = new Map([[name, { entityType: "AWS::IAM::Role", props: {} }]]);
      const result = await up({
        ...REQUEST,
        entityNames: [name],
        entities: declared,
        edges: [],
        edgeCoverage: { verdict: "unknown" },
      });
      if (isBehaviourRefusalReport(result)) throw new Error("expected a report");
      expect(Object.prototype.hasOwnProperty.call(result.unpredicted ?? {}, name)).toBe(true);
    });
  }
});

describe("a substrate augur does not model is a boundary, not a gap (D3)", () => {
  test("names the substrate rather than telling the reader to add a row", async () => {
    const declared = new Map([
      ["bucket", { entityType: "GCP::Storage::Bucket", props: {} }],
      ["chart", { entityType: "Helm::Chart", props: {} }],
    ]);
    const result = await up({
      ...REQUEST,
      entityNames: [...declared.keys()],
      entities: declared,
      edges: [],
      edgeCoverage: { verdict: "unknown" },
    });
    if (isBehaviourRefusalReport(result)) throw new Error("expected a report");
    expect(result.unpredicted?.bucket?.detail).toContain("Google Cloud");
    expect(result.unpredicted?.bucket?.detail).toContain("stated boundary rather than a gap");
    expect(result.unpredicted?.bucket?.detail).not.toContain("Add a row");
    expect(result.unpredicted?.chart?.detail).toContain("Helm");
  });
});

describe("an engine that answers badly is unreachable, not a stop (D1)", () => {
  test("refuses a malformed figure rather than throwing the lexicon down", async () => {
    // The distinction that matters: a throw is what the credential value-arm
    // uses, and an engine emitting one bad number is not a leak.
    const predict = createAugurPredict({
      env: UP,
      connect: (endpoint) => ({
        async predict() {
          const parsed = parseEngineAnswer(
            JSON.stringify({
              engine: "e",
              version: "1",
              tolerance: "±5%",
              basis: "modeled",
              figures: { web: { perHour: 0.1, currency: "USD" } },
            }),
          );
          if (parsed.ok) throw new Error("the malformed figure was accepted");
          return { ok: false, refusal: unreachableBehaviourEngineRefusal("augur", endpoint, parsed.detail) };
        },
      }),
    });
    const result = await predict(REQUEST);
    expect(isBehaviourRefusalReport(result)).toBe(true);
    if (!isBehaviourRefusalReport(result)) return;
    expect(result.refusal.cause).toBe("engine-unreachable");
    expect(result.refusal.reason).toContain("figures.web");
  });
});
