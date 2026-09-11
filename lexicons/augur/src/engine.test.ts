/**
 * The engine level over the contract's transport (#2357, #2373), and the
 * things about it that are not bookkeeping: a malformed answer refuses rather
 * than half-reporting, the child process does not inherit this one's
 * environment, and the chooser routes a URL to core's HTTP transport rather
 * than refusing it.
 */

import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isBehaviourRefusalReport } from "@intentius/chant/behaviour";
import { commandEngine, connectWith, defaultConnect, figureProblems, parseEngineAnswer } from "./engine";
import type { EngineRequest } from "./request";

const REQUEST: EngineRequest = {
  request: "augur/v1",
  traffic: "100 rps, p50",
  nodes: [{ name: "web", entityType: "AWS::EC2::Instance", kind: "compute", provider: "aws", size: "t3.medium" }],
  edges: [],
  coverage: { verdict: "unknown" },
  withheld: [],
};

const NO_ENV: Record<string, string | undefined> = {};

/** Write a node script to a temp dir and return an endpoint a command engine can dial. */
function scriptEngine(body: string): { value: string; source: string } {
  const dir = mkdtempSync(join(tmpdir(), "augur-engine-"));
  const file = join(dir, "engine.mjs");
  writeFileSync(file, body);
  chmodSync(file, 0o755);
  return { value: `${process.execPath} ${file}`, source: "CHANT_BEHAVIOUR_ENGINE" };
}

describe("an engine's answer, parsed", () => {
  it("refuses text that is not JSON rather than reporting an estate with holes", () => {
    // Taking the fields that parsed and reporting the rest unpredicted would
    // turn an engine emitting garbage into an estate that looks partly free —
    // the failure the refusal arm exists to prevent, one level down.
    const parsed = parseEngineAnswer("<html>502 Bad Gateway</html>");
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.detail).toContain("not JSON");
  });

  it("refuses an answer that cannot say who produced it", () => {
    const parsed = parseEngineAnswer(JSON.stringify({ figures: {} }));
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.detail).toContain("engine, version, tolerance");
  });

  it("refuses an answer with no figures map at all", () => {
    const parsed = parseEngineAnswer(
      JSON.stringify({ engine: "e", version: "1", tolerance: "±5%", basis: "modeled" }),
    );
    expect(parsed.ok).toBe(false);
  });

  it("accepts a well-formed answer", () => {
    const parsed = parseEngineAnswer(
      JSON.stringify({ engine: "e", version: "1", tolerance: "±5%", basis: "modeled", figures: {} }),
    );
    expect(parsed.ok).toBe(true);
  });
});

describe("the transport chooser", () => {
  it("dials a command on PATH", () => {
    expect(defaultConnect({ value: "augur-engine --model tiny", source: "CHANT_BEHAVIOUR_ENGINE" }, NO_ENV)).toBeDefined();
  });

  it("dials a URL through the contract's HTTP transport (#2359)", () => {
    // Not refused any more: the adapter landed in core, and augur routes a
    // http(s) address at it. Whether a token is set is the transport's to
    // refuse on, at send time, by name.
    expect(defaultConnect({ value: "https://engine.example/predict", source: "CHANT_BEHAVIOUR_ENGINE" }, NO_ENV)).toBeDefined();
    expect(defaultConnect({ value: "http://localhost:8080/predict", source: "CHANT_BEHAVIOUR_ENGINE" }, NO_ENV)).toBeDefined();
  });

  it("declines a scheme no transport speaks", () => {
    expect(defaultConnect({ value: "grpc://engine.internal:9000", source: "BEHAVIOUR_ENGINE" }, NO_ENV)).toBeUndefined();
    expect(defaultConnect({ value: "unix:///var/run/engine.sock", source: "BEHAVIOUR_ENGINE" }, NO_ENV)).toBeUndefined();
  });

  it("declines an empty address", () => {
    expect(defaultConnect({ value: "   ", source: "BEHAVIOUR_ENGINE" }, NO_ENV)).toBeUndefined();
  });

  it("hands the injected fetch to the HTTP transport, and the environment's token with it", async () => {
    const seen: { url: string; auth: string | null; body: string }[] = [];
    const fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      seen.push({
        url: String(url),
        auth: new Headers(init?.headers).get("authorization"),
        body: String(init?.body),
      });
      return new Response(
        JSON.stringify({ engine: "e", version: "1", tolerance: "±5%", basis: "modeled", figures: {} }),
        { status: 200 },
      );
    }) as typeof globalThis.fetch;
    const engine = connectWith({ fetch })(
      { value: "https://engine.example/predict", source: "CHANT_BEHAVIOUR_ENGINE" },
      { CHANT_BEHAVIOUR_TOKEN: "tok-from-the-injected-env" },
    );
    expect(engine).toBeDefined();
    const outcome = await engine!.predict(REQUEST);
    expect(outcome.ok).toBe(true);
    expect(seen).toHaveLength(1);
    expect(seen[0].url).toBe("https://engine.example/predict");
    expect(seen[0].auth).toBe("Bearer tok-from-the-injected-env");
    // The canonical request, byte for byte — the same bytes the golden holds.
    expect(JSON.parse(seen[0].body)).toMatchObject({ request: "augur/v1", traffic: "100 rps, p50" });
  });
});

describe("a command engine", () => {
  it("sends the request on stdin and reads the answer from stdout", async () => {
    const endpoint = scriptEngine(`
      let body = "";
      process.stdin.on("data", (c) => { body += c; });
      process.stdin.on("end", () => {
        const request = JSON.parse(body);
        process.stdout.write(JSON.stringify({
          engine: "script", version: "0.1", tolerance: "±30%", basis: "modeled",
          figures: Object.fromEntries(request.nodes.map((n) => [n.name, {
            perHour: 0.5, currency: "USD",
            headroom: { cpu: 0.5, latency: 0.5 },
            errorRate: 0.01,
            // Echoed so the test can prove the request reached the child's
            // stdin and was parsed there, not merely that a process ran.
            resilience: { failure: "one zone lost", verdict: "survives", note: n.kind },
          }])),
        }));
      });
    `);
    const outcome = await commandEngine(endpoint).predict(REQUEST);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.answer.engine).toBe("script");
    expect(outcome.answer.figures.web.resilience.note).toBe("compute");
  });

  it("does not hand the child this process's environment", async () => {
    // Rule 3 says the engine never sees a credential, and
    // `screenBehaviourRequest` enforces that on the request. A subprocess
    // inheriting `process.env` walks straight around it: the request is
    // spotless and the child holds the whole environment anyway. The rule is
    // `behaviourEngineChildEnvironment` in core; this pins that augur uses it.
    process.env.AUGUR_TEST_FAKE_SECRET = "hunter2-should-not-travel";
    try {
      const endpoint = scriptEngine(`
        process.stdin.resume();
        process.stdin.on("end", () => {
          process.stdout.write(JSON.stringify({
            engine: "script", version: "0.1", tolerance: "±30%", basis: "modeled",
            figures: {}, declined: { env: Object.keys(process.env).sort().join(",") },
          }));
        });
      `);
      const outcome = await commandEngine(endpoint).predict(REQUEST);
      expect(outcome.ok).toBe(true);
      if (!outcome.ok) return;
      const inherited = (outcome.answer.declined?.env ?? "").split(",").filter((k) => k.length > 0);
      expect(inherited).not.toContain("AUGUR_TEST_FAKE_SECRET");
      // `PATH` is what the address is resolved against, and it is the only
      // name core's rule puts there. Anything else the child holds came from
      // the platform's own spawn (macOS adds `__CF_USER_TEXT_ENCODING`), never
      // from chant's environment — so the assertion is that nothing of ours
      // travels, not that the child's environment is empty.
      expect(inherited).toContain("PATH");
      expect(inherited.filter((k) => !k.startsWith("__") && k !== "PATH")).toEqual([]);
    } finally {
      delete process.env.AUGUR_TEST_FAKE_SECRET;
    }
  });

  it("reads an out-of-credit refusal off stderr, and does not call it unreachable", async () => {
    // The address is fine and the request arrived. Reporting this as
    // unreachable sends an operator to debug a network that is answering.
    const endpoint = scriptEngine(`
      process.stdin.resume();
      process.stdin.on("end", () => {
        process.stderr.write("refused: the account is out of credit\\n");
        process.exit(2);
      });
    `);
    const outcome = await commandEngine(endpoint).predict(REQUEST);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.refusal.refusal.cause).toBe("engine-out-of-credit");
    expect(outcome.refusal.refusal.reason).toContain("out of credit");
    expect(outcome.refusal.refusal.remedy).not.toMatch(/reachable/i);
  });

  it("reads a spent quota off stderr", async () => {
    const endpoint = scriptEngine(`
      process.stdin.resume();
      process.stdin.on("end", () => {
        process.stderr.write("429: rate limit reached, retry after 900s\\n");
        process.exit(3);
      });
    `);
    const outcome = await commandEngine(endpoint).predict(REQUEST);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.refusal.refusal.cause).toBe("engine-over-quota");
  });

  it("treats a command that is not there as unreachable, naming the variable", async () => {
    const outcome = await commandEngine({
      value: "augur-engine-that-does-not-exist",
      source: "CHANT_BEHAVIOUR_ENGINE_AUGUR",
    }).predict(REQUEST);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(isBehaviourRefusalReport(outcome.refusal)).toBe(true);
    expect(outcome.refusal.refusal.cause).toBe("engine-unreachable");
    expect(outcome.refusal.refusal.source).toBe("CHANT_BEHAVIOUR_ENGINE_AUGUR");
  });

  it("turns an answer that does not parse into an unreachable refusal naming the field", async () => {
    const endpoint = scriptEngine(`
      process.stdin.resume();
      process.stdin.on("end", () => {
        process.stdout.write(JSON.stringify({
          engine: "script", version: "0.1", tolerance: "±30%", basis: "modeled",
          figures: { web: { perHour: -1, currency: "USD" } },
        }));
      });
    `);
    const outcome = await commandEngine(endpoint).predict(REQUEST);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.refusal.refusal.cause).toBe("engine-unreachable");
    expect(outcome.refusal.refusal.reason).toContain("figures.web.perHour");
  });
});

describe("a malformed figure refuses, and never throws (D1)", () => {
  const envelope = { engine: "e", version: "1", tolerance: "±5%", basis: "modeled" as const };
  const good = {
    perHour: 0.1,
    currency: "USD",
    headroom: { cpu: 0.5, latency: 0.5 },
    errorRate: 0.01,
    resilience: { failure: "one zone lost", verdict: "survives" },
  };

  /**
   * The seven shapes an engine can get wrong, each executed against the first
   * version of this parser and each of which threw: three as bare `TypeError`s
   * out of `block()` with no chant message, four out of
   * `validateBehaviourBlock` after the report was half built. A throw is the
   * whole-lexicon failure `lexicon.ts` reserves for a live credential in the
   * request, so a third party emitting one bad number looked exactly like a
   * leak.
   */
  const malformed: Array<[string, unknown, RegExp]> = [
    ["no resilience at all", { ...good, resilience: undefined }, /resilience is missing/],
    ["a null figure", null, /is object, not an object/],
    ["a string figure", "cheap", /is string, not an object/],
    ["an array figure", [1, 2], /is an array, not an object/],
    ["a stringified rate", { ...good, perHour: "1.0" }, /perHour is not a non-negative finite number/],
    ["a negative rate", { ...good, perHour: -1 }, /perHour is not a non-negative finite number/],
    ["no headroom", { ...good, headroom: undefined }, /headroom is missing/],
    ["an empty headroom", { ...good, headroom: {} }, /headroom carries neither cpu nor latency/],
    ["a headroom out of 0..1", { ...good, headroom: { cpu: 7 } }, /headroom.cpu is not a number in 0..1/],
    ["an errorRate out of 0..1", { ...good, errorRate: 12 }, /errorRate is not a number in 0..1/],
    ["a bogus verdict", { ...good, resilience: { failure: "x", verdict: "explodes" } }, /verdict is not survives/],
    ["a verdict with no failure", { ...good, resilience: { failure: "", verdict: "fails" } }, /names no failure/],
    ["no currency", { ...good, currency: "" }, /currency is empty/],
    ["a rightSize with no suggestion", { ...good, rightSize: {} }, /rightSize.suggestion is missing/],
  ];

  for (const [label, figure, message] of malformed) {
    it(`refuses ${label}, naming the entity and the field`, () => {
      const parsed = parseEngineAnswer(JSON.stringify({ ...envelope, figures: { web: figure } }));
      expect(parsed.ok, `${label} was accepted`).toBe(false);
      if (parsed.ok) return;
      expect(parsed.detail).toMatch(message);
      // Named, because "the engine sent something wrong" is not actionable.
      expect(parsed.detail).toContain("figures.web");
    });
  }

  it("refuses a basis outside the closed enum", () => {
    const parsed = parseEngineAnswer(JSON.stringify({ ...envelope, basis: "vibes", figures: {} }));
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.detail).toMatch(/not\s+modeled or validated/);
  });

  it("refuses a negative estate total", () => {
    const parsed = parseEngineAnswer(
      JSON.stringify({ ...envelope, total: { perHour: -3, currency: "USD" }, figures: {} }),
    );
    expect(parsed.ok).toBe(false);
  });

  it("refuses an array where the figures map should be", () => {
    // `typeof [] === "object"`, so `figures: []` parsed clean and produced a
    // report in which every node the request named had been lost.
    const parsed = parseEngineAnswer(JSON.stringify({ ...envelope, figures: [] }));
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.detail).toContain("no figures map");
  });

  it("refuses a declined reason that is not a string", () => {
    const parsed = parseEngineAnswer(
      JSON.stringify({ ...envelope, figures: {}, declined: { web: 7 } }),
    );
    expect(parsed.ok).toBe(false);
  });

  it("accepts a figure that models one headroom axis and not the other", () => {
    // An unmodelled axis is absent, never zero. Both one-axis shapes are legal.
    for (const headroom of [{ cpu: 0.4 }, { latency: 0.9 }]) {
      expect(parseEngineAnswer(JSON.stringify({ ...envelope, figures: { web: { ...good, headroom } } })).ok).toBe(true);
    }
  });

  it("reports several problems at once rather than only the first", () => {
    const parsed = parseEngineAnswer(
      JSON.stringify({ ...envelope, figures: { web: { perHour: -1, currency: "", errorRate: 9 } } }),
    );
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.detail).toContain("perHour");
    expect(parsed.detail).toContain("currency");
    expect(parsed.detail).toContain("errorRate");
  });

  it("figureProblems is empty for a well-formed figure", () => {
    expect(figureProblems("web", good)).toEqual([]);
  });
});
