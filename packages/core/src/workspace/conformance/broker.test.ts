/**
 * The broker suite (#3164) against the reference broker, which serves every
 * standard capability and must pass, and against two brokers that break the
 * protocol, which the suite must catch.
 */

import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, test } from "vitest";
import { BROKER_ROUTES } from "../broker-protocol";
import { describeBrokerConformance } from "./vitest";
import { startReferenceBroker } from "./__fixtures__/reference-broker";
import { BROKER_CONFORMANCE_CAPABILITIES, runBrokerConformance, schemaInstance, type BrokerConformanceEnv, type BrokerListen, type StartedBroker } from "./index";

/** The suite's upstreams on loopback ports, as a broker's test serves them. */
const listen: BrokerListen = (handler) =>
  new Promise((resolve) => {
    const server = createServer(handler);
    server.listen(0, "127.0.0.1", () =>
      resolve({ url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, close: () => new Promise<void>((r) => server.close(() => r())) }),
    );
  });

describeBrokerConformance({ name: "the reference broker", start: startReferenceBroker, listen, capabilities: BROKER_CONFORMANCE_CAPABILITIES });

/**
 * The reference broker behind a proxy that changes each request with
 * `rewrite` on the way in, so a test makes a broker that breaks one rule.
 */
async function behind(
  env: BrokerConformanceEnv,
  rewrite: (path: string, headers: Record<string, string>, body: string) => { headers: Record<string, string>; body: string },
  answered: (path: string, headers: Record<string, string>) => void = () => {},
): Promise<StartedBroker> {
  const inner = await startReferenceBroker(env);
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(req.headers)) if (v !== undefined && k !== "host" && k !== "content-length" && k !== "connection") headers[k] = [v].flat().join(", ");
    const changed = rewrite(req.url ?? "/", headers, body);
    const answer = await fetch(`${inner.url}${req.url}`, { method: req.method, headers: changed.headers, body: req.method === "GET" || req.method === "HEAD" ? undefined : changed.body });
    const out: Record<string, string> = {};
    answer.headers.forEach((v, k) => {
      if (!["content-length", "content-encoding", "transfer-encoding", "connection", "keep-alive"].includes(k)) out[k] = v;
    });
    answered(req.url ?? "/", out);
    res.writeHead(answer.status, out);
    res.end(Buffer.from(await answer.arrayBuffer()));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    tokens: inner.tokens,
    close: async () => {
      await new Promise<void>((r) => server.close(() => r()));
      await inner.close?.();
    },
  };
}

describe("the broker suite catches a broker that breaks the protocol", () => {
  test("a broker that grants every scope whatever the box declared fails each refusal check", async () => {
    const all = (broker: string) => ({
      capabilities: [
        { name: "inference", broker, scope: ["agent", "decide"] },
        { name: "egress", broker, scope: ["CONFORMANCE", "CONFORMANCE_UNHELD"] },
        { name: "feedback", broker, scope: ["agent", "passive"] },
        { name: "fountain", broker, scope: ["agent", "conversations", "sandboxes", "vault"] },
      ],
    });
    const report = await runBrokerConformance({
      name: "grants everything",
      listen,
      capabilities: BROKER_CONFORMANCE_CAPABILITIES,
      start: (env) => behind(env, (path, headers, body) => ({ headers, body: path === BROKER_ROUTES.declaration && body.includes('"capabilities"') ? JSON.stringify(all(env.broker)) : body })),
    });
    const failed = new Set(report.results.filter((r) => r.problems.length > 0).map((r) => r.id));
    for (const id of ["inference-agent-refused", "decide-refused", "egress-refused", "feedback-refused", "fountain-refused"]) expect(failed, id).toContain(id);
    expect(failed).not.toContain("inference-forwards");
    expect(failed).not.toContain("unreported-refused");
  }, 60_000);

  test("a broker that passes a box's token upstream fails token-isolation", async () => {
    const report = await runBrokerConformance({
      name: "leaks the token",
      listen,
      start: (env) => behind(env, (_path, headers, body) => ({ headers: { ...headers, "x-box-token": headers.authorization ?? headers["x-api-key"] ?? "" }, body })),
    });
    const isolation = report.results.find((r) => r.id === "token-isolation");
    expect(isolation?.problems.length).toBeGreaterThan(0);
    expect(report.problems.every((p) => p.startsWith("token-isolation:"))).toBe(true);
  }, 60_000);

  test("a broker whose payer differs between the report's answer and a Messages answer, or is said on one only, fails payer-consistent (#3474)", async () => {
    for (const change of [(h: Record<string, string>) => (h["chant-payer"] = "visitor github:someone"), (h: Record<string, string>) => delete h["chant-payer"]]) {
      const report = await runBrokerConformance({
        name: "payer disagrees",
        listen,
        start: (env) => behind(env, (_path, headers, body) => ({ headers, body }), (path, headers) => path.startsWith(BROKER_ROUTES.inference) && change(headers)),
      });
      expect(report.problems.length).toBeGreaterThan(0);
      expect(report.problems.every((p) => p.startsWith("payer-consistent:"))).toBe(true);
    }
  }, 60_000);

  test("the default capabilities are the lobby's, and fountain's checks are skipped", async () => {
    const report = await runBrokerConformance({ name: "the reference broker as a lobby", start: startReferenceBroker, listen });
    expect(report.problems).toEqual([]);
    expect(report.results.filter((r) => r.skipped).map((r) => r.id)).toEqual(["fountain-forwards", "fountain-refused"]);
  }, 60_000);
});

describe("schemaInstance", () => {
  test("answers a structured-output schema with the first option and an even split", () => {
    const schema = {
      type: "object",
      properties: { reason: { type: "string" }, choice: { type: "string", enum: ["small", "large"] }, probabilities: { type: "object", properties: { small: { type: "number" }, large: { type: "number" } } } },
    };
    expect(schemaInstance(schema)).toEqual({ reason: "The conformance upstream's reason.", choice: "small", probabilities: { small: 0.5, large: 0.5 } });
  });
});
