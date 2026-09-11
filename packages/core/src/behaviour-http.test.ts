/**
 * The first engine adapter (#2359), against a fake wire.
 *
 * Three things are proven here and nowhere else. The wire mapping: each
 * status and each way `fetch` can throw lands on the cause the contract fixes
 * for it, and on no other. The token: it goes in the header, it is read from
 * its own chain most specific first, and its value appears in no refusal of
 * any of the four kinds even when the engine echoes it back. And the shape of
 * what is sent: `POST`, the body byte for byte, a JSON content type, and no
 * redirect followed.
 */

import { describe, expect, test } from "vitest";
import {
  behaviourEngineFrom,
  behaviourTokenFrom,
  behaviourTokenVariables,
  isBehaviourRefusalReport,
  type BehaviourEngineEndpoint,
  type BehaviourRefusalReport,
  type BehaviourTransportOutcome,
} from "./behaviour";
import {
  concealing,
  httpBehaviourTransport,
  httpStatusRefusal,
  isHttpBehaviourAddress,
  HTTP_BEHAVIOUR_TIMEOUT_MS,
} from "./behaviour-http";

/**
 * A value no denylist knows. Not `sk-…`, not `ghp_…`, not `Bearer …`: those
 * shapes are already blanked by `scrubEngineDetail` through `identity.ts`, so
 * a token in one of them passes every leak test below with the adapter's own
 * concealment deleted — which the first version of this file did, on an
 * `sk-` value. What is being proven is that the *configured* token is
 * concealed, whatever it looks like.
 */
const TOKEN = "acme-9f8e7d6c5b4a3210-not-for-print";
const ENDPOINT: BehaviourEngineEndpoint = {
  value: "https://engine.example/v1/predict",
  source: "CHANT_BEHAVIOUR_ENGINE",
};
const ENV = { CHANT_BEHAVIOUR_TOKEN: TOKEN };
const BODY = '{\n  "request": "acme/v1",\n  "traffic": "100 rps, p50"\n}\n';

/** One call the fake wire saw. */
interface Seen {
  url: string;
  method: string | undefined;
  headers: Headers;
  body: string;
  redirect: RequestRedirect | undefined;
  signal: AbortSignal | undefined;
}

/**
 * A `fetch` that answers every call the same way and records what it was
 * handed. `answer` may throw, to stand in for a socket error.
 */
function wire(answer: () => Response | Promise<Response>): { fetch: typeof globalThis.fetch; seen: Seen[] } {
  const seen: Seen[] = [];
  const fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    seen.push({
      url: String(url),
      method: init?.method,
      headers: new Headers(init?.headers),
      body: String(init?.body),
      redirect: init?.redirect,
      signal: init?.signal ?? undefined,
    });
    return answer();
  }) as typeof globalThis.fetch;
  return { fetch, seen };
}

const answering = (status: number, text: string, headers: Record<string, string> = {}) =>
  wire(() => new Response(text, { status, headers }));

/** The refusal from an outcome, or a thrown error naming what came back instead. */
function refusalOf(outcome: BehaviourTransportOutcome): BehaviourRefusalReport {
  if (outcome.ok) throw new Error(`expected a refusal, got an answer: ${outcome.body}`);
  return outcome.refusal;
}

/* -------------------------------------------------------------------------- */
/* The token chain                                                            */
/* -------------------------------------------------------------------------- */

describe("the token chain (#2359)", () => {
  test("is parallel to the address chain and shares no variable with it", () => {
    expect(behaviourTokenVariables("acme")).toEqual([
      "CHANT_BEHAVIOUR_TOKEN_ACME",
      "CHANT_BEHAVIOUR_TOKEN",
      "BEHAVIOUR_TOKEN",
    ]);
    // An address is printed in refusals and a token never is, so a variable
    // in one chain must not be in the other.
    const addresses = ["CHANT_BEHAVIOUR_ENGINE_ACME", "CHANT_BEHAVIOUR_ENGINE", "BEHAVIOUR_ENGINE"];
    for (const v of behaviourTokenVariables("acme")) expect(addresses).not.toContain(v);
  });

  test("reads most specific first, and names the variable that won", () => {
    expect(
      behaviourTokenFrom("acme", {
        CHANT_BEHAVIOUR_TOKEN_ACME: "scoped",
        CHANT_BEHAVIOUR_TOKEN: "chant-wide",
        BEHAVIOUR_TOKEN: "bare",
      }),
    ).toEqual({ value: "scoped", source: "CHANT_BEHAVIOUR_TOKEN_ACME" });
    expect(behaviourTokenFrom("acme", { CHANT_BEHAVIOUR_TOKEN: "chant-wide", BEHAVIOUR_TOKEN: "bare" })).toEqual({
      value: "chant-wide",
      source: "CHANT_BEHAVIOUR_TOKEN",
    });
    expect(behaviourTokenFrom("acme", { BEHAVIOUR_TOKEN: "bare" })).toEqual({ value: "bare", source: "BEHAVIOUR_TOKEN" });
  });

  test("skips a blank variable rather than sending an empty bearer", () => {
    expect(behaviourTokenFrom("acme", { CHANT_BEHAVIOUR_TOKEN_ACME: "   ", BEHAVIOUR_TOKEN: "bare" })).toEqual({
      value: "bare",
      source: "BEHAVIOUR_TOKEN",
    });
    expect(behaviourTokenFrom("acme", {})).toBeUndefined();
  });

  test("the address chain does not resolve a token, and the token chain does not resolve an address", () => {
    const env = { CHANT_BEHAVIOUR_ENGINE: "https://engine.example", CHANT_BEHAVIOUR_TOKEN: TOKEN };
    expect(behaviourEngineFrom("acme", env)?.value).toBe("https://engine.example");
    expect(behaviourTokenFrom("acme", env)?.value).toBe(TOKEN);
    expect(behaviourEngineFrom("acme", { CHANT_BEHAVIOUR_TOKEN: TOKEN })).toBeUndefined();
    expect(behaviourTokenFrom("acme", { CHANT_BEHAVIOUR_ENGINE: "https://engine.example" })).toBeUndefined();
  });
});

/* -------------------------------------------------------------------------- */
/* What is sent                                                               */
/* -------------------------------------------------------------------------- */

describe("what the adapter puts on the wire", () => {
  test("POSTs the body byte for byte, as JSON, with the bearer token in the header", async () => {
    const { fetch, seen } = answering(200, '{"engine":"e"}');
    const outcome = await httpBehaviourTransport("acme", ENDPOINT, ENV, { fetch }).send(BODY);
    expect(outcome).toEqual({ ok: true, body: '{"engine":"e"}' });
    expect(seen).toHaveLength(1);
    const [call] = seen;
    expect(call.url).toBe("https://engine.example/v1/predict");
    expect(call.method).toBe("POST");
    expect(call.body).toBe(BODY);
    expect(call.headers.get("content-type")).toBe("application/json");
    expect(call.headers.get("accept")).toBe("application/json");
    expect(call.headers.get("authorization")).toBe(`Bearer ${TOKEN}`);
  });

  test("the token is in the header and not in the body", async () => {
    const { fetch, seen } = answering(200, "{}");
    await httpBehaviourTransport("acme", ENDPOINT, ENV, { fetch }).send(BODY);
    expect(seen[0].body).not.toContain(TOKEN);
  });

  test("does not follow a redirect, which would carry the header to another host", async () => {
    const { fetch, seen } = answering(200, "{}");
    await httpBehaviourTransport("acme", ENDPOINT, ENV, { fetch }).send(BODY);
    expect(seen[0].redirect).toBe("error");
  });

  test("sends with a deadline", async () => {
    const { fetch, seen } = answering(200, "{}");
    await httpBehaviourTransport("acme", ENDPOINT, ENV, { fetch }).send(BODY);
    expect(seen[0].signal).toBeInstanceOf(AbortSignal);
    expect(HTTP_BEHAVIOUR_TIMEOUT_MS).toBe(30_000);
  });

  test("uses the most specific token variable when two are set", async () => {
    const { fetch, seen } = answering(200, "{}");
    await httpBehaviourTransport(
      "acme",
      ENDPOINT,
      { CHANT_BEHAVIOUR_TOKEN_ACME: "scoped-token-value", CHANT_BEHAVIOUR_TOKEN: TOKEN },
      { fetch },
    ).send(BODY);
    expect(seen[0].headers.get("authorization")).toBe("Bearer scoped-token-value");
  });

  test("dials http and https, and nothing else", () => {
    expect(isHttpBehaviourAddress("https://engine.example/predict")).toBe(true);
    expect(isHttpBehaviourAddress("http://localhost:8080/predict")).toBe(true);
    expect(isHttpBehaviourAddress("  HTTPS://ENGINE.EXAMPLE ")).toBe(true);
    expect(isHttpBehaviourAddress("grpc://engine.internal:9000")).toBe(false);
    expect(isHttpBehaviourAddress("/var/run/engine.sock")).toBe(false);
    expect(isHttpBehaviourAddress("acme-engine --model tiny")).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */
/* No token, nothing sent                                                     */
/* -------------------------------------------------------------------------- */

describe("no token configured", () => {
  test("refuses before sending, naming the three variables, as `no-engine`", async () => {
    const { fetch, seen } = answering(200, "{}");
    const outcome = await httpBehaviourTransport("acme", ENDPOINT, {}, { fetch }).send(BODY);
    const { refusal } = refusalOf(outcome);
    expect(seen, "nothing may be sent without a token").toEqual([]);
    expect(refusal.cause).toBe("no-engine");
    expect(refusal.reason).toContain("CHANT_BEHAVIOUR_TOKEN_ACME");
    expect(refusal.reason).toContain("CHANT_BEHAVIOUR_TOKEN");
    expect(refusal.reason).toContain("BEHAVIOUR_TOKEN");
    expect(refusal.reason).toContain("engine.example");
    expect(refusal.reason).toContain("CHANT_BEHAVIOUR_ENGINE");
    expect(refusal.remedy).toBe("Set CHANT_BEHAVIOUR_TOKEN to the bearer token the engine at https://engine.example/v1/predict issued.");
    // The address chain answered; the refusal is about the token chain, in
    // which nothing did, so there is no `source`.
    expect(refusal.source).toBeUndefined();
  });

  test("the address is redacted in the no-token refusal too", async () => {
    const { fetch } = answering(200, "{}");
    const leaky = { value: "https://svc:s3cr3t@engine.example/predict?key=abc123", source: "BEHAVIOUR_ENGINE" };
    const { refusal } = refusalOf(await httpBehaviourTransport("acme", leaky, {}, { fetch }).send(BODY));
    for (const text of [refusal.reason, refusal.remedy]) {
      expect(text).not.toContain("s3cr3t");
      expect(text).not.toContain("abc123");
      expect(text).toContain("engine.example");
    }
  });
});

/* -------------------------------------------------------------------------- */
/* The wire mapping                                                           */
/* -------------------------------------------------------------------------- */

describe("what the wire says, and what it becomes", () => {
  test("402 is `engine-out-of-credit`, naming the token variable and not the network", async () => {
    const { fetch } = answering(402, '{"error":"balance 0.00 USD"}');
    const { refusal } = refusalOf(await httpBehaviourTransport("acme", ENDPOINT, ENV, { fetch }).send(BODY));
    expect(refusal.cause).toBe("engine-out-of-credit");
    expect(refusal.source).toBe("CHANT_BEHAVIOUR_ENGINE");
    // The condition, and both variables: the address that answered and the
    // token whose account is empty.
    expect(refusal.reason).toContain("out of credit");
    expect(refusal.reason).toContain("HTTP 402");
    expect(refusal.reason).toContain("balance 0.00 USD");
    expect(refusal.reason).toContain("CHANT_BEHAVIOUR_TOKEN");
    expect(refusal.reason).toContain("CHANT_BEHAVIOUR_ENGINE");
    expect(refusal.reason).not.toMatch(/unreachable|did not answer/i);
    expect(refusal.remedy).not.toMatch(/reachable/i);
    expect(refusal.remedy).toMatch(/credit|fund/i);
  });

  test("429 is `engine-over-quota`, echoing retry-after, and not out of credit", async () => {
    const { fetch } = answering(429, "too many requests", { "retry-after": "900" });
    const { refusal } = refusalOf(await httpBehaviourTransport("acme", ENDPOINT, ENV, { fetch }).send(BODY));
    expect(refusal.cause).toBe("engine-over-quota");
    expect(refusal.reason).toContain("HTTP 429");
    expect(refusal.reason).toContain("retry after 900");
    expect(refusal.reason).toContain("CHANT_BEHAVIOUR_TOKEN");
    expect(refusal.remedy).toMatch(/quota|limit|window|wait/i);
    expect(refusal.remedy).not.toMatch(/credit|fund/i);
  });

  test("a 5xx is `engine-unreachable`, naming the status", async () => {
    const { fetch } = answering(503, "<html>Service Unavailable</html>");
    const { refusal } = refusalOf(await httpBehaviourTransport("acme", ENDPOINT, ENV, { fetch }).send(BODY));
    expect(refusal.cause).toBe("engine-unreachable");
    expect(refusal.source).toBe("CHANT_BEHAVIOUR_ENGINE");
    expect(refusal.reason).toContain("HTTP 503");
    expect(refusal.remedy).toMatch(/reachable|repoint/i);
  });

  test("a connection refused is `engine-unreachable`, naming the socket error", async () => {
    const { fetch } = wire(() => {
      throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED", message: "connect ECONNREFUSED 127.0.0.1:443" } });
    });
    const { refusal } = refusalOf(await httpBehaviourTransport("acme", ENDPOINT, ENV, { fetch }).send(BODY));
    expect(refusal.cause).toBe("engine-unreachable");
    expect(refusal.reason).toContain("ECONNREFUSED");
  });

  test("a timeout is `engine-unreachable`, naming the deadline", async () => {
    // The fake waits on the signal the adapter hands it, and rejects with the
    // signal's own reason — which is what undici does when the deadline
    // passes — so the real `AbortSignal.timeout` path is the one under test.
    const fetch = (async (_url: string | URL | Request, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
      })) as typeof globalThis.fetch;
    const { refusal } = refusalOf(
      await httpBehaviourTransport("acme", ENDPOINT, ENV, { fetch, timeoutMs: 5 }).send(BODY),
    );
    expect(refusal.cause).toBe("engine-unreachable");
    expect(refusal.reason).toContain("no answer within 5 ms");
  });

  test("a redirect refused by fetch is `engine-unreachable`", async () => {
    const { fetch } = wire(() => {
      throw Object.assign(new TypeError("fetch failed"), { cause: { code: undefined, message: "unexpected redirect" } });
    });
    const { refusal } = refusalOf(await httpBehaviourTransport("acme", ENDPOINT, ENV, { fetch }).send(BODY));
    expect(refusal.cause).toBe("engine-unreachable");
  });

  test("401 and 403 are `no-engine` naming the token variable that was rejected", async () => {
    for (const status of [401, 403]) {
      const { fetch } = answering(status, "invalid token");
      const { refusal } = refusalOf(await httpBehaviourTransport("acme", ENDPOINT, ENV, { fetch }).send(BODY));
      expect(refusal.cause, `HTTP ${status}`).toBe("no-engine");
      expect(refusal.source).toBe("CHANT_BEHAVIOUR_TOKEN");
      expect(refusal.reason).toContain(`HTTP ${status}`);
      expect(refusal.reason).toContain("rejected the token CHANT_BEHAVIOUR_TOKEN holds");
      expect(refusal.remedy).toBe("Set CHANT_BEHAVIOUR_TOKEN to a bearer token the engine at https://engine.example/v1/predict accepts.");
      expect(refusal.remedy).not.toMatch(/reachable|credit/i);
    }
  });

  test("any other non-2xx is `engine-unreachable`, with the status in the detail", () => {
    const token = { value: TOKEN, source: "CHANT_BEHAVIOUR_TOKEN" };
    for (const status of [301, 400, 404, 418, 422, 500, 502]) {
      const refusal = httpStatusRefusal("acme", ENDPOINT, token, status, "")!;
      expect(refusal.refusal.cause, `HTTP ${status}`).toBe("engine-unreachable");
      expect(refusal.refusal.reason).toContain(`HTTP ${status}`);
    }
    for (const status of [200, 201, 204]) {
      expect(httpStatusRefusal("acme", ENDPOINT, token, status, "")).toBeUndefined();
    }
  });

  test("the four kinds are four distinct causes from one wire", async () => {
    const causes = await Promise.all(
      [
        httpBehaviourTransport("acme", ENDPOINT, {}, answering(200, "{}")).send(BODY),
        httpBehaviourTransport("acme", ENDPOINT, ENV, answering(503, "down")).send(BODY),
        httpBehaviourTransport("acme", ENDPOINT, ENV, answering(402, "broke")).send(BODY),
        httpBehaviourTransport("acme", ENDPOINT, ENV, answering(429, "throttled")).send(BODY),
      ].map(async (p) => refusalOf(await p).refusal.cause),
    );
    expect(causes).toEqual(["no-engine", "engine-unreachable", "engine-out-of-credit", "engine-over-quota"]);
  });

  test("a 2xx answer is handed back as text, unparsed — the lexicon owns the wire version", async () => {
    const { fetch } = answering(200, "not json at all");
    const outcome = await httpBehaviourTransport("acme", ENDPOINT, ENV, { fetch }).send(BODY);
    expect(outcome).toEqual({ ok: true, body: "not json at all" });
  });
});

/* -------------------------------------------------------------------------- */
/* The token is never printed                                                 */
/* -------------------------------------------------------------------------- */

describe("the token appears in no refusal of any kind (#2358 posts these publicly)", () => {
  /**
   * Every way the wire can refuse, each with the engine echoing the token it
   * was sent back into its error body as a bare value — which is what a JSON
   * error body carries — so the one path a token could take into a message is
   * exercised on every kind.
   *
   * Bare, not `Bearer …`: `scrubEngineDetail` already blanks anything in the
   * `Bearer <16+ chars>` shape through `CREDENTIAL_SHAPES`, so an echo in that
   * shape passes with {@link concealing} deleted (it did: 47/47 green under
   * that tamper). The value on its own is the case only this adapter catches.
   */
  const echo = `{"error":"token ${TOKEN} is not valid for this account","request_id":"r-1"}`;
  const kinds: Array<[string, () => { fetch: typeof globalThis.fetch }]> = [
    ["no-engine (rejected token, 401)", () => answering(401, echo)],
    ["no-engine (rejected token, 403)", () => answering(403, echo)],
    ["engine-unreachable (503)", () => answering(503, echo)],
    ["engine-unreachable (thrown)", () => wire(() => { throw new Error(`socket hung up after sending ${echo}`); })],
    ["engine-out-of-credit (402)", () => answering(402, echo)],
    ["engine-over-quota (429)", () => answering(429, echo, { "retry-after": "60" })],
  ];

  for (const [kind, make] of kinds) {
    test(`${kind}: neither the reason nor the remedy carries the token`, async () => {
      const { fetch } = make();
      const outcome = await httpBehaviourTransport("acme", ENDPOINT, ENV, { fetch }).send(BODY);
      const { refusal } = refusalOf(outcome);
      expect(isBehaviourRefusalReport(outcome.ok ? undefined! : outcome.refusal)).toBe(true);
      for (const [field, text] of Object.entries(refusal)) {
        expect(String(text), `${kind}: the token leaked through refusal.${field}`).not.toContain(TOKEN);
      }
      // The whole object, serialized: no field anyone adds later can carry it
      // past this assertion.
      expect(JSON.stringify(outcome)).not.toContain(TOKEN);
    });
  }

  test("the no-token refusal has no token to leak, and names the variables only", async () => {
    const { fetch } = answering(401, echo);
    const outcome = await httpBehaviourTransport("acme", ENDPOINT, {}, { fetch }).send(BODY);
    expect(JSON.stringify(outcome)).not.toContain(TOKEN);
  });

  test("a token the engine echoes into a 2xx body is concealed there too", async () => {
    const { fetch } = answering(200, `{"echo":"${TOKEN}"}`);
    const outcome = await httpBehaviourTransport("acme", ENDPOINT, ENV, { fetch }).send(BODY);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.body).not.toContain(TOKEN);
    expect(outcome.body).toContain("[redacted]");
  });

  test("concealing replaces every occurrence, and leaves a too-short token's text alone", () => {
    const token = { value: TOKEN, source: "CHANT_BEHAVIOUR_TOKEN" };
    expect(concealing(token, `a ${TOKEN} b ${TOKEN} c`)).toBe("a [redacted] b [redacted] c");
    expect(concealing(token, "nothing here")).toBe("nothing here");
    // A one-letter "token" would blank every `a` in the detail. Not concealed,
    // and not a secret anybody has.
    expect(concealing({ value: "a", source: "BEHAVIOUR_TOKEN" }, "a detail about a thing")).toBe("a detail about a thing");
  });

  test("a token with regex metacharacters is matched as itself", () => {
    const token = { value: "sk.live+9f8e/7d6c=", source: "BEHAVIOUR_TOKEN" };
    expect(concealing(token, "sent sk.live+9f8e/7d6c= twice: sk.live+9f8e/7d6c=")).toBe("sent [redacted] twice: [redacted]");
  });
});

/* -------------------------------------------------------------------------- */
/* What a consumer can assume about the two strings it prints                 */
/* -------------------------------------------------------------------------- */

/**
 * behold renders `refusal.reason` and `refusal.remedy` verbatim and bounds
 * neither (`validateBehaviourMeta` requires both and reads nothing else), and
 * a refusal from one estate member blanks the overlay for the whole estate —
 * so those two strings are the only text on screen explaining why. Two things
 * follow, and both are this adapter's to hold rather than the consumer's.
 */
describe("the two strings a consumer prints", () => {
  test("an engine that writes a novel gets a bounded reason, not the novel", async () => {
    const novel = `balance 0.00 USD. ${"why this happened, at length. ".repeat(500)}`;
    const { fetch } = answering(402, novel);
    const { refusal } = refusalOf(await httpBehaviourTransport("acme", ENDPOINT, ENV, { fetch }).send(BODY));
    // `firstLine` bounds what is quoted and `scrubEngineDetail` bounds it
    // again; a reason that ran to the engine's whole page would be the only
    // thing on a consumer's screen.
    expect(refusal.reason.length).toBeLessThan(1000);
    expect(refusal.reason).toContain("balance 0.00 USD");
  });

  test("every refusal this adapter can build says something and says what to do", async () => {
    const kinds: Array<[string, () => Promise<BehaviourTransportOutcome>]> = [
      ["no token", () => httpBehaviourTransport("acme", ENDPOINT, {}, { fetch: answering(200, "{}").fetch }).send(BODY)],
      ["401", () => httpBehaviourTransport("acme", ENDPOINT, ENV, { fetch: answering(401, "nope").fetch }).send(BODY)],
      ["402", () => httpBehaviourTransport("acme", ENDPOINT, ENV, { fetch: answering(402, "empty").fetch }).send(BODY)],
      ["429", () => httpBehaviourTransport("acme", ENDPOINT, ENV, { fetch: answering(429, "slow down").fetch }).send(BODY)],
      ["503", () => httpBehaviourTransport("acme", ENDPOINT, ENV, { fetch: answering(503, "").fetch }).send(BODY)],
    ];
    for (const [kind, run] of kinds) {
      const { refusal } = refusalOf(await run());
      expect(refusal.reason.trim(), `${kind}: an empty reason`).not.toHaveLength(0);
      expect(refusal.remedy.trim(), `${kind}: an empty remedy`).not.toHaveLength(0);
      // A remedy that names no variable is a dead end for whoever reads it.
      expect(refusal.remedy, `${kind}: the remedy names no variable`).toMatch(/\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b/);
    }
  });
});
