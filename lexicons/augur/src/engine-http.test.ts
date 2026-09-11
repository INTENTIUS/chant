/**
 * augur end to end over the first engine adapter (#2359): `predictBehaviour`
 * with a URL address, a token in the environment, and a fake wire standing in
 * for the engine.
 *
 * `./engine.test.ts` proves the engine level and `packages/core`'s
 * `behaviour-http.test.ts` proves the wire mapping in isolation. This file
 * proves the two compose: what augur renders reaches the wire as the request,
 * what the wire answers comes back as a report or a refusal, and the token
 * that authenticated the call is in none of the text either way.
 */

import { describe, expect, test } from "vitest";
import { describeBehaviourConformance } from "@intentius/chant-test-utils";
import { isBehaviourRefusalReport, type PredictBehaviourOptions } from "@intentius/chant/behaviour";
import type { IREdge } from "@intentius/chant/graph-ir";
import { createAugurPredict } from "./predict-behaviour";
import { connectWith, defaultConnect } from "./engine";
import { fixtureEngine, FIXTURE_ENGINE_NAME } from "./__fixtures__/fixture-engine";
import type { EngineRequest } from "./request";

const TOKEN = "augur-live-3c2b1a0f9e8d7c6b5a4-never-printed";
const ADDRESS = "https://engine.example/v1/predict";

const ENV = { CHANT_BEHAVIOUR_ENGINE: ADDRESS, CHANT_BEHAVIOUR_TOKEN: TOKEN };

/** Three mapped entities and one declared unmapped, with the edges between the mapped ones. */
const DECLARED = new Map<string, { entityType: string; props: Record<string, unknown> }>([
  ["web", { entityType: "AWS::EC2::Instance", props: { InstanceType: "t3.medium" } }],
  ["db", { entityType: "AWS::RDS::DBInstance", props: { DBInstanceClass: "db.t3.medium" } }],
  ["orders", { entityType: "AWS::SQS::Queue", props: { QueueName: "orders" } }],
  ["appRole", { entityType: "AWS::IAM::Role", props: { RoleName: "app" } }],
]);

const EDGES: IREdge[] = [
  { from: "web", to: "db", kind: "ref", viaAttr: "dbEndpoint", toAttr: "Endpoint_Address" },
  { from: "web", to: "orders", kind: "ref", viaAttr: "queueUrl", toAttr: "QueueUrl" },
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

/** A figure the engine would send for one node, with `note` carrying what it was sent. */
const figure = (note: string) => ({
  perHour: 0.25,
  currency: "USD",
  headroom: { cpu: 0.6, latency: 0.5 },
  errorRate: 0.001,
  resilience: { failure: "one zone lost", verdict: "survives", note },
});

/** One call the fake wire saw. */
interface Seen {
  url: string;
  method: string | undefined;
  authorization: string | null;
  request: EngineRequest;
}

/**
 * A fake wire: records each call and answers from `respond`, which is handed
 * the parsed request so a test can build an answer that depends on it.
 */
function wire(respond: (request: EngineRequest) => Response) {
  const seen: Seen[] = [];
  const fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const request = JSON.parse(String(init?.body)) as EngineRequest;
    seen.push({
      url: String(url),
      method: init?.method,
      authorization: new Headers(init?.headers).get("authorization"),
      request,
    });
    return respond(request);
  }) as typeof globalThis.fetch;
  const predict = createAugurPredict({ env: ENV, connect: connectWith({ fetch }) });
  return { seen, predict };
}

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

/** An engine that prices every node it is sent, echoing what it was sent in each note. */
const pricingEverything = (request: EngineRequest) =>
  json(200, {
    engine: "wire-engine",
    version: "2.0.0",
    tolerance: "±10%",
    basis: "modeled",
    total: { perHour: 0.75, currency: "USD" },
    figures: Object.fromEntries(
      request.nodes.map((n) => [n.name, figure(`${n.kind}/${n.provider}/${n.size ?? "-"}/${n.region ?? "-"}`)]),
    ),
  });

/* -------------------------------------------------------------------------- */
/* The request mapping                                                        */
/* -------------------------------------------------------------------------- */

describe("the request reaches the wire as augur rendered it", () => {
  test("three mapped entities go, the declared-unmapped one is withheld by name, and the token is in the header", async () => {
    const { seen, predict } = wire(pricingEverything);
    const result = await predict(REQUEST);
    expect(isBehaviourRefusalReport(result)).toBe(false);

    expect(seen).toHaveLength(1);
    const [call] = seen;
    expect(call.url).toBe(ADDRESS);
    expect(call.method).toBe("POST");
    expect(call.authorization).toBe(`Bearer ${TOKEN}`);

    expect(call.request.request).toBe("augur/v1");
    expect(call.request.traffic).toBe("100 rps, p50");
    expect(call.request.nodes.map((n) => n.name)).toEqual(["db", "orders", "web"]);
    expect(call.request.nodes.find((n) => n.name === "db")).toEqual({
      name: "db",
      entityType: "AWS::RDS::DBInstance",
      kind: "database",
      provider: "aws",
      region: "us-east-1",
      size: "db.t3.medium",
    });
    expect(call.request.edges).toEqual([
      { from: "web", to: "db", via: "dbEndpoint", toAttr: "Endpoint_Address" },
      { from: "web", to: "orders", via: "queueUrl", toAttr: "QueueUrl" },
    ]);
    expect(call.request.withheld.map((w) => [w.name, w.status])).toEqual([["appRole", "declared-unmapped"]]);
    expect(call.request.coverage).toEqual({ verdict: "complete" });
  });

  test("the body carries no credential: not the token, and not the address variable's value either", async () => {
    const { seen, predict } = wire(pricingEverything);
    await predict(REQUEST);
    expect(JSON.stringify(seen[0].request)).not.toContain(TOKEN);
  });
});

/* -------------------------------------------------------------------------- */
/* The response mapping                                                       */
/* -------------------------------------------------------------------------- */

describe("the answer comes back as a report", () => {
  test("figures land on the entities the engine priced, with the engine's own provenance", async () => {
    const { predict } = wire(pricingEverything);
    const result = await predict(REQUEST);
    if (isBehaviourRefusalReport(result)) throw new Error(`refused: ${result.refusal.reason}`);

    expect(Object.keys(result.entities).sort()).toEqual(["db", "orders", "web"]);
    expect(result.meta.engine).toBe("wire-engine");
    expect(result.meta.version).toBe("2.0.0");
    expect(result.meta.total).toEqual({ rate: "per-hour", perHour: 0.75, currency: "USD" });
    expect(result.meta.at.traffic).toBe("100 rps, p50");

    const db = result.entities.db;
    expect(db.cost).toEqual({ rate: "per-hour", perHour: 0.25, currency: "USD" });
    expect(db.provenance).toEqual({ engine: "wire-engine", version: "2.0.0", tolerance: "±10%", basis: "modeled" });
    // What the engine was sent, echoed back through its note: kind, provider,
    // size and region all crossed the wire intact.
    expect(db.resilience.note).toBe("database/aws/db.t3.medium/us-east-1");
    expect(result.entities.orders.resilience.note).toBe("queue/aws/-/us-east-1");

    expect(result.unpredicted?.appRole?.reason).toBe("unsupported-kind");
    expect(result.unpredicted?.appRole?.detail).toContain("AWS::IAM::Role");
  });

  test("a per-entity decline from the engine's side is `read-failed` naming the engine's reason", async () => {
    const { predict } = wire((request) =>
      json(200, {
        engine: "wire-engine",
        version: "2.0.0",
        tolerance: "±10%",
        basis: "modeled",
        figures: Object.fromEntries(
          request.nodes.filter((n) => n.name !== "db").map((n) => [n.name, figure(n.kind)]),
        ),
        declined: { db: "no price model for db.t3.medium in us-east-1" },
      }),
    );
    const result = await predict(REQUEST);
    if (isBehaviourRefusalReport(result)) throw new Error(`refused: ${result.refusal.reason}`);

    expect(Object.keys(result.entities).sort()).toEqual(["orders", "web"]);
    expect(result.unpredicted?.db?.reason).toBe("read-failed");
    expect(result.unpredicted?.db?.type).toBe("AWS::RDS::DBInstance");
    expect(result.unpredicted?.db?.detail).toContain("wire-engine was sent db as a database and declined it");
    expect(result.unpredicted?.db?.detail).toContain("no price model for db.t3.medium in us-east-1");
    // Still every entity somewhere: three verdicts plus the withheld one.
    expect(Object.keys(result.unpredicted ?? {}).sort()).toEqual(["appRole", "db"]);
  });

  test("an answer that does not parse is `engine-unreachable` naming the field, never a throw", async () => {
    const { predict } = wire(() =>
      json(200, {
        engine: "wire-engine",
        version: "2.0.0",
        tolerance: "±10%",
        basis: "modeled",
        figures: { web: { perHour: "free", currency: "USD" } },
      }),
    );
    const result = await predict(REQUEST);
    if (!isBehaviourRefusalReport(result)) throw new Error("expected a refusal");
    expect(result.refusal.cause).toBe("engine-unreachable");
    expect(result.refusal.reason).toContain("figures.web.perHour");
  });
});

/* -------------------------------------------------------------------------- */
/* The four wire conditions, end to end                                       */
/* -------------------------------------------------------------------------- */

describe("each wire condition is its own refusal, naming the variable", () => {
  test("402: `engine-out-of-credit`, naming the condition and both variables, and not the network", async () => {
    const { predict } = wire(() => json(402, { error: "balance 0.00 USD" }));
    const result = await predict(REQUEST);
    if (!isBehaviourRefusalReport(result)) throw new Error("expected a refusal");
    expect(result.refusal.cause).toBe("engine-out-of-credit");
    expect(result.refusal.reason).toContain("out of credit");
    expect(result.refusal.reason).toContain("balance 0.00 USD");
    expect(result.refusal.reason).toContain("CHANT_BEHAVIOUR_ENGINE");
    expect(result.refusal.reason).toContain("CHANT_BEHAVIOUR_TOKEN");
    expect(result.refusal.reason).not.toMatch(/unreachable|did not answer/i);
    expect(result.refusal.remedy).toBe(
      "Add credit to the account behind CHANT_BEHAVIOUR_ENGINE, or repoint it at a funded engine.",
    );
  });

  test("429: `engine-over-quota`, with the window the engine named", async () => {
    const { predict } = wire(() => json(429, { error: "5000/5000 predictions this hour" }, { "retry-after": "1800" }));
    const result = await predict(REQUEST);
    if (!isBehaviourRefusalReport(result)) throw new Error("expected a refusal");
    expect(result.refusal.cause).toBe("engine-over-quota");
    expect(result.refusal.reason).toContain("retry after 1800");
    expect(result.refusal.reason).toContain("5000/5000");
    expect(result.refusal.remedy).toMatch(/window|limit/i);
    expect(result.refusal.remedy).not.toMatch(/credit/i);
  });

  test("503 and a refused connection: `engine-unreachable`, naming the address variable", async () => {
    const down = wire(() => new Response("upstream down", { status: 503 }));
    const result = await down.predict(REQUEST);
    if (!isBehaviourRefusalReport(result)) throw new Error("expected a refusal");
    expect(result.refusal.cause).toBe("engine-unreachable");
    expect(result.refusal.source).toBe("CHANT_BEHAVIOUR_ENGINE");
    expect(result.refusal.reason).toContain("HTTP 503");

    const refused = wire(() => {
      throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } });
    });
    const second = await refused.predict(REQUEST);
    if (!isBehaviourRefusalReport(second)) throw new Error("expected a refusal");
    expect(second.refusal.cause).toBe("engine-unreachable");
    expect(second.refusal.reason).toContain("ECONNREFUSED");
  });

  test("no token set: `no-engine` naming the token chain, and nothing is sent", async () => {
    const seen: string[] = [];
    const fetch = (async (url: string | URL | Request) => {
      seen.push(String(url));
      return json(200, {});
    }) as typeof globalThis.fetch;
    const predict = createAugurPredict({
      env: { CHANT_BEHAVIOUR_ENGINE: ADDRESS },
      connect: connectWith({ fetch }),
    });
    const result = await predict(REQUEST);
    if (!isBehaviourRefusalReport(result)) throw new Error("expected a refusal");
    expect(seen).toEqual([]);
    expect(result.refusal.cause).toBe("no-engine");
    expect(result.refusal.reason).toContain("CHANT_BEHAVIOUR_TOKEN_AUGUR");
    expect(result.refusal.reason).toContain("CHANT_BEHAVIOUR_TOKEN");
    expect(result.refusal.reason).toContain("BEHAVIOUR_TOKEN");
    expect(result.refusal.remedy).toContain("Set CHANT_BEHAVIOUR_TOKEN");
  });

  test("no address set: `no-engine` naming the address chain, whatever the token", async () => {
    const predict = createAugurPredict({ env: { CHANT_BEHAVIOUR_TOKEN: TOKEN }, connect: connectWith() });
    const result = await predict(REQUEST);
    if (!isBehaviourRefusalReport(result)) throw new Error("expected a refusal");
    expect(result.refusal.cause).toBe("no-engine");
    expect(result.refusal.reason).toContain("CHANT_BEHAVIOUR_ENGINE");
    expect(JSON.stringify(result)).not.toContain(TOKEN);
  });
});

/* -------------------------------------------------------------------------- */
/* The token is never printed                                                 */
/* -------------------------------------------------------------------------- */

describe("CHANT_BEHAVIOUR_TOKEN's value is in no refusal text, for any of the four kinds", () => {
  /**
   * The engine echoing the bare token into every error it writes. Bare on
   * purpose: core's `scrubEngineDetail` already blanks a `Bearer …`-shaped
   * string, so that echo would pass with the adapter's own concealment gone.
   */
  const echo = { error: `token ${TOKEN} is not valid for this account` };
  const kinds: Array<[string, () => Response]> = [
    ["no-engine (401, token rejected)", () => json(401, echo)],
    ["engine-unreachable (503)", () => json(503, echo)],
    ["engine-out-of-credit (402)", () => json(402, echo)],
    ["engine-over-quota (429)", () => json(429, echo)],
  ];

  for (const [kind, respond] of kinds) {
    test(`${kind}`, async () => {
      const { predict } = wire(respond);
      const result = await predict(REQUEST);
      if (!isBehaviourRefusalReport(result)) throw new Error("expected a refusal");
      expect(result.refusal.reason, `${kind}: the token leaked through the reason`).not.toContain(TOKEN);
      expect(result.refusal.remedy, `${kind}: the token leaked through the remedy`).not.toContain(TOKEN);
      expect(result.refusal.source ?? "", `${kind}: the token leaked through source`).not.toContain(TOKEN);
      expect(JSON.stringify(result), `${kind}: the token leaked somewhere in the result`).not.toContain(TOKEN);
      // The variable's name is what a refusal carries, on the kinds where the
      // token is what the refusal is about.
      if (kind.startsWith("no-engine")) expect(result.refusal.reason).toContain("CHANT_BEHAVIOUR_TOKEN");
    });
  }

  test("the four causes are distinct, and the no-token one is not one of the wire's three", async () => {
    const causes = [];
    for (const [, respond] of kinds) {
      const result = await wire(respond).predict(REQUEST);
      if (!isBehaviourRefusalReport(result)) throw new Error("expected a refusal");
      causes.push(result.refusal.cause);
    }
    expect(causes).toEqual(["no-engine", "engine-unreachable", "engine-out-of-credit", "engine-over-quota"]);
  });
});

/* -------------------------------------------------------------------------- */
/* The engine that answers 200 and refuses in the envelope                    */
/* -------------------------------------------------------------------------- */

/**
 * A status is the transport's evidence and it is not the only evidence there
 * is. An engine that takes the request, answers 200, and writes
 * `{"error": "out of credit"}` is a real shape — every hosted API has a
 * version of it — and `packages/core`'s status table has nothing to say about
 * it, because by the time the body is read the status has already been ruled
 * an answer.
 *
 * So the words are read here, one level up, on a body that failed to parse as
 * an answer. Which is the whole of the ordering rule the last test pins.
 */
describe("a 200 whose body is a refusal rather than an answer", () => {
  test("out-of-credit words are that refusal by name, not `the engine emitted garbage`", async () => {
    // The difference this makes to an operator: one sends them to their
    // billing page, the other sends them to debug an engine that is working.
    const { predict } = wire(() => json(200, { error: "out of credit: top up to continue" }));
    const result = await predict(REQUEST);
    if (!isBehaviourRefusalReport(result)) throw new Error("expected a refusal");
    expect(result.refusal.cause).toBe("engine-out-of-credit");
    expect(result.refusal.reason).toContain("out of credit: top up to continue");
    expect(result.refusal.reason).toContain("CHANT_BEHAVIOUR_ENGINE");
  });

  test("quota words take the quota arm", async () => {
    const { predict } = wire(() => json(200, { error: "quota exceeded for this account" }));
    const result = await predict(REQUEST);
    if (!isBehaviourRefusalReport(result)) throw new Error("expected a refusal");
    expect(result.refusal.cause).toBe("engine-over-quota");
  });

  test("a body with none of those words stays unreachable, naming the field that was wrong", async () => {
    const { predict } = wire(() => json(200, { engine: "e", version: "1", tolerance: "±5%", basis: "modeled" }));
    const result = await predict(REQUEST);
    if (!isBehaviourRefusalReport(result)) throw new Error("expected a refusal");
    expect(result.refusal.cause).toBe("engine-unreachable");
    expect(result.refusal.reason).toContain("figures");
  });

  test("a priced answer that merely mentions a rate limit is still a priced answer", async () => {
    // The ordering assertion, and the reason the words are read second. An
    // engine declining one node "rate limit reached for this region's price
    // feed" parses fine; a vocabulary check running first would throw away a
    // report about three priced nodes and refuse about none of them.
    const { predict } = wire((request) =>
      json(200, {
        engine: "wire-engine",
        version: "2.0.0",
        tolerance: "±10%",
        basis: "modeled",
        total: { perHour: 0.75, currency: "USD" },
        figures: Object.fromEntries(request.nodes.map((n) => [n.name, figure("priced")])),
        declined: { appRole: "rate limit reached for this region's price feed" },
      }),
    );
    const result = await predict(REQUEST);
    expect(isBehaviourRefusalReport(result)).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */
/* The shared suite, a second time, with the engine on the far side of a wire */
/* -------------------------------------------------------------------------- */

/**
 * `./predict-behaviour.test.ts` runs `describeBehaviourConformance` over the
 * fixture engine in process. Running the same suite here, with that same
 * fixture answering as a response body, is what says this adapter is *behind*
 * the seam rather than beside it: the scenarios are the same scenarios, the
 * contract's assertions are the same assertions, and the only difference is
 * that the answer arrives with a status code on it.
 *
 * It is worth the duplication because the two halves fail differently. A bug
 * in the adapter that drops `traffic` or flattens the edges would leave every
 * test above green — they assert on what the wire carried and on what came
 * back — and only the suite's probes, which ask twice and require the answers
 * to move, would see it.
 */

/** The fixture, served over the wire: a request body in, an answer body out. */
const fixtureOverWire = (options: Parameters<typeof fixtureEngine>[0] = {}) =>
  (async (_url: string | URL | Request, init?: RequestInit) => {
    const request = JSON.parse(String(init?.body)) as EngineRequest;
    const outcome = await fixtureEngine(options).predict(request);
    // The fixture's refusal arm is a finished report, which is not a thing a
    // wire can carry. Every refusing scenario below drives the status instead,
    // which is what an engine would actually do.
    if (!outcome.ok) throw new Error("the fixture refused; drive the status directly instead");
    return json(200, outcome.answer);
  }) as typeof globalThis.fetch;

const predictOver = (env: Record<string, string | undefined>, fetchLike: typeof globalThis.fetch) =>
  createAugurPredict({ env, connect: connectWith({ fetch: fetchLike }) });

/**
 * Three edges rather than the two the tests above use. `probeReadsEdges` drops
 * the last one and requires the answer to move; with two, dropping the last
 * disconnects `orders` altogether, and an engine keying on a
 * connected/not-connected boolean would pass a probe it should fail.
 */
const SUITE_EDGES: IREdge[] = [
  ...EDGES,
  { from: "db", to: "orders", kind: "ref", viaAttr: "deadLetterQueue", toAttr: "Arn" },
];

const SUITE_REQUEST: PredictBehaviourOptions = { ...REQUEST, edges: SUITE_EDGES };

const overWire = predictOver(ENV, fixtureOverWire());

describeBehaviourConformance({
  lexicon: "augur over the first engine adapter (#2359)",
  scenarios: [
    {
      name: "the engine is up at a URL",
      declared: [...DECLARED.keys()],
      traffic: "100 rps, p50",
      run: () => overWire(SUITE_REQUEST),
      request: SUITE_REQUEST,
      predict: overWire,
      otherTraffic: "1000 rps, p99",
      expectPredicted: ["web", "db", "orders"],
      expectUnpredicted: { appRole: "unsupported-kind" },
    },
    {
      name: "the URL is named and no variable names a token",
      declared: [...DECLARED.keys()],
      run: () => predictOver({ CHANT_BEHAVIOUR_ENGINE: ADDRESS }, fixtureOverWire())(SUITE_REQUEST),
      expectRefusal: true,
      expectRefusalCause: "no-engine",
    },
    {
      name: "the URL answers 503",
      declared: [...DECLARED.keys()],
      run: () => predictOver(ENV, (async () => json(503, "upstream gone")) as typeof globalThis.fetch)(SUITE_REQUEST),
      expectRefusal: true,
      expectRefusalCause: "engine-unreachable",
    },
    {
      name: "the URL answers 402",
      declared: [...DECLARED.keys()],
      run: () =>
        predictOver(
          ENV,
          (async () => json(402, { error: "balance 0.00 USD" })) as typeof globalThis.fetch,
        )(SUITE_REQUEST),
      expectRefusal: true,
      expectRefusalCause: "engine-out-of-credit",
    },
    {
      name: "the URL answers 429",
      declared: [...DECLARED.keys()],
      run: () =>
        predictOver(
          ENV,
          (async () => json(429, { error: "quota exceeded" }, { "retry-after": "60" })) as typeof globalThis.fetch,
        )(SUITE_REQUEST),
      expectRefusal: true,
      expectRefusalCause: "engine-over-quota",
    },
    {
      name: "the URL answers 401",
      declared: [...DECLARED.keys()],
      run: () =>
        predictOver(
          ENV,
          (async () => json(401, { error: "invalid api key" })) as typeof globalThis.fetch,
        )(SUITE_REQUEST),
      expectRefusal: true,
      expectRefusalCause: "no-engine",
    },
  ],
});

describe("the adapter, end to end", () => {
  test("prices the estate the fixture priced, over the wire, with the fixture's own provenance", async () => {
    const result = await overWire(SUITE_REQUEST);
    if (isBehaviourRefusalReport(result)) throw new Error("expected a report");
    expect(Object.keys(result.entities).sort()).toEqual(["db", "orders", "web"]);
    expect(result.meta.engine).toBe(FIXTURE_ENGINE_NAME);
  });

  test("a 402 reaches the operator naming the account's variable, with no figures anywhere", async () => {
    // The second half of #2359 in one assertion: not a silent stop and not a
    // networking complaint, but the sentence that names what ran out and which
    // variable authenticated to the account it ran out on.
    const result = await predictOver(
      ENV,
      (async () => json(402, { error: "balance 0.00 USD" })) as typeof globalThis.fetch,
    )(SUITE_REQUEST);
    if (!isBehaviourRefusalReport(result)) throw new Error("expected a refusal");
    expect(result.refusal.cause).toBe("engine-out-of-credit");
    expect(result.refusal.reason).toContain("CHANT_BEHAVIOUR_TOKEN");
    expect(Object.prototype.hasOwnProperty.call(result, "entities")).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */
/* The chooser, dialling rather than merely defined                           */
/* -------------------------------------------------------------------------- */

describe("the shipped chooser reaches the process's own fetch", () => {
  // Which schemes the chooser speaks is `./engine.test.ts`'s, and the wire
  // mapping is `packages/core`'s. What is this file's is that `defaultConnect`
  // — the one the plugin actually ships, with no injected `fetch` — POSTs to
  // the address it was handed. A chooser returning something merely defined
  // passes every other test here and dials nowhere.
  test("a URL address POSTs to that URL, with the token the injected environment held", async () => {
    const seen: Array<{ url: string; authorization: string | null }> = [];
    const original = globalThis.fetch;
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      seen.push({ url: String(url), authorization: new Headers(init?.headers).get("authorization") });
      return json(200, {
        engine: "wire-engine",
        version: "2.0.0",
        tolerance: "±10%",
        basis: "modeled",
        figures: { web: figure("dialled") },
      });
    }) as typeof globalThis.fetch;
    try {
      const engine = defaultConnect({ value: ADDRESS, source: "CHANT_BEHAVIOUR_ENGINE" }, ENV);
      expect(engine).toBeDefined();
      const outcome = await engine!.predict({
        request: "augur/v1",
        traffic: "100 rps, p50",
        nodes: [{ name: "web", entityType: "AWS::EC2::Instance", kind: "compute", provider: "aws", size: "t3.medium" }],
        edges: [],
        coverage: { verdict: "complete" },
        withheld: [],
      });
      expect(outcome.ok).toBe(true);
    } finally {
      globalThis.fetch = original;
    }
    expect(seen).toHaveLength(1);
    expect(seen[0].url).toBe(ADDRESS);
    expect(seen[0].authorization).toBe(`Bearer ${TOKEN}`);
  });
});
