/**
 * The transport seam (#2357), and the two things about it that are not
 * bookkeeping: a malformed answer refuses rather than half-reporting, and the
 * child process does not inherit this one's environment.
 */

import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { commandEngine, defaultConnect, parseEngineAnswer } from "./engine";
import type { EngineRequest } from "./request";

const REQUEST: EngineRequest = {
  request: "augur/v1",
  traffic: "100 rps, p50",
  nodes: [{ name: "web", entityType: "AWS::EC2::Instance", kind: "compute", provider: "aws", size: "t3.medium" }],
  edges: [],
  coverage: { verdict: "unknown" },
  withheld: [],
};

/** Write a node script to a temp dir and return an address a command engine can dial. */
function scriptEngine(body: string): string {
  const dir = mkdtempSync(join(tmpdir(), "augur-engine-"));
  const file = join(dir, "engine.mjs");
  writeFileSync(file, body);
  chmodSync(file, 0o755);
  return `${process.execPath} ${file}`;
}

describe("an engine's answer, parsed", () => {
  it("refuses text that is not JSON rather than reporting an estate with holes", () => {
    // Taking the fields that parsed and reporting the rest unpredicted would
    // turn an engine emitting garbage into an estate that looks partly free —
    // the failure the refusal arm exists to prevent, one level down.
    const outcome = parseEngineAnswer("<html>502 Bad Gateway</html>");
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.failure.cause).toBe("engine-unreachable");
    expect(outcome.failure.detail).toContain("not JSON");
  });

  it("refuses an answer that cannot say who produced it", () => {
    const outcome = parseEngineAnswer(JSON.stringify({ figures: {} }));
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.failure.detail).toContain("engine, version, tolerance, basis");
  });

  it("refuses an answer with no figures map at all", () => {
    const outcome = parseEngineAnswer(
      JSON.stringify({ engine: "e", version: "1", tolerance: "±5%", basis: "modeled" }),
    );
    expect(outcome.ok).toBe(false);
  });

  it("accepts a well-formed answer", () => {
    const outcome = parseEngineAnswer(
      JSON.stringify({ engine: "e", version: "1", tolerance: "±5%", basis: "modeled", figures: {} }),
    );
    expect(outcome.ok).toBe(true);
  });
});

describe("the transport chooser", () => {
  it("dials a command on PATH", () => {
    expect(defaultConnect({ value: "augur-engine --model tiny", source: "CHANT_BEHAVIOUR_ENGINE" })).toBeDefined();
  });

  it("declines a URL, which is the first engine adapter's (#2359)", () => {
    // Not a fetch invented here. Guessing an HTTP shape would hand #2359 a
    // decision already made badly rather than an open seam.
    expect(defaultConnect({ value: "https://engine.example/predict", source: "CHANT_BEHAVIOUR_ENGINE" })).toBeUndefined();
    expect(defaultConnect({ value: "grpc://engine.internal:9000", source: "BEHAVIOUR_ENGINE" })).toBeUndefined();
  });

  it("declines an empty address", () => {
    expect(defaultConnect({ value: "   ", source: "BEHAVIOUR_ENGINE" })).toBeUndefined();
  });
});

describe("a command engine", () => {
  it("sends the request on stdin and reads the answer from stdout", async () => {
    const address = scriptEngine(`
      let body = "";
      process.stdin.on("data", (c) => { body += c; });
      process.stdin.on("end", () => {
        const request = JSON.parse(body);
        process.stdout.write(JSON.stringify({
          engine: "script", version: "0.1", tolerance: "±30%", basis: "modeled",
          figures: Object.fromEntries(request.nodes.map((n) => [n.name, { seen: n.kind }])),
        }));
      });
    `);
    const outcome = await commandEngine(address).predict(REQUEST);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.answer.engine).toBe("script");
    expect(outcome.answer.figures.web).toEqual({ seen: "compute" });
  });

  it("does not hand the child this process's environment", async () => {
    // Rule 3 says the engine never sees a credential, and
    // `screenBehaviourRequest` enforces that on the request. A subprocess
    // inheriting `process.env` walks straight around it: the request is
    // spotless and the child holds the whole environment anyway.
    process.env.AUGUR_TEST_FAKE_SECRET = "hunter2-should-not-travel";
    try {
      const address = scriptEngine(`
        process.stdin.resume();
        process.stdin.on("end", () => {
          process.stdout.write(JSON.stringify({
            engine: "script", version: "0.1", tolerance: "±30%", basis: "modeled",
            figures: {}, declined: { env: Object.keys(process.env).sort().join(",") },
          }));
        });
      `);
      const outcome = await commandEngine(address).predict(REQUEST);
      expect(outcome.ok).toBe(true);
      if (!outcome.ok) return;
      const inherited = (outcome.answer.declined?.env ?? "").split(",").filter((k) => k.length > 0);
      expect(inherited).not.toContain("AUGUR_TEST_FAKE_SECRET");
      // `PATH` is what the address is resolved against, and it is the only
      // name this file puts there. Anything else the child holds came from the
      // platform's own spawn (macOS adds `__CF_USER_TEXT_ENCODING`), never from
      // chant's environment — so the assertion is that nothing of ours travels,
      // not that the child's environment is empty.
      expect(inherited).toContain("PATH");
      expect(inherited.filter((k) => !k.startsWith("__") && k !== "PATH")).toEqual([]);
    } finally {
      delete process.env.AUGUR_TEST_FAKE_SECRET;
    }
  });

  it("reads an out-of-credit refusal off stderr, and does not call it unreachable", async () => {
    // The address is fine and the request arrived. Reporting this as
    // unreachable sends an operator to debug a network that is answering.
    const address = scriptEngine(`
      process.stdin.resume();
      process.stdin.on("end", () => {
        process.stderr.write("refused: the account is out of credit\\n");
        process.exit(2);
      });
    `);
    const outcome = await commandEngine(address).predict(REQUEST);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.failure.cause).toBe("engine-out-of-credit");
  });

  it("reads a spent quota off stderr", async () => {
    const address = scriptEngine(`
      process.stdin.resume();
      process.stdin.on("end", () => {
        process.stderr.write("429: rate limit reached, retry after 900s\\n");
        process.exit(3);
      });
    `);
    const outcome = await commandEngine(address).predict(REQUEST);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.failure.cause).toBe("engine-over-quota");
  });

  it("treats a command that is not there as unreachable", async () => {
    const outcome = await commandEngine("augur-engine-that-does-not-exist").predict(REQUEST);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.failure.cause).toBe("engine-unreachable");
  });
});
