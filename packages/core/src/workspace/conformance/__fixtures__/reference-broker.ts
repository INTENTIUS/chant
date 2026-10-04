/**
 * The reference broker (#3164, ws-097): the smallest broker of the broker
 * protocol (`../broker-protocol.ts`) that passes the conformance suite
 * (`./broker.ts`), serving all four standard capabilities. It keeps every
 * report in memory and buffers each request, which a real broker should not;
 * it exists to show the suite can be passed and what passing takes, and for
 * a test to run a box against without studio's lobby.
 *
 * It is a test fixture and the package does not export it: chant never runs
 * a broker or listens on a port (ws-052, ws-086), so it lives under
 * `__fixtures__`, which test/no-listener.test.ts leaves out like a test file.
 * `startReferenceBroker(env)` has the shape of the suite's `start`.
 */

import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import {
  BROKER_ROUTES,
  DECLARATION_LIMITS,
  declaredRefusal,
  EGRESS_CAPABILITY,
  FEEDBACK_CAPABILITY,
  FOUNTAIN_CAPABILITY,
  INFERENCE_CAPABILITY,
  parseDeclarationReport,
  formatPayerHeader,
  PAYER_HEADER,
  type BrokerPayer,
  type KeptDeclaration,
} from "../../broker-protocol";
import type { BrokerConformanceEnv, StartedBroker } from "../broker";

const MAX_BODY = 1024 * 1024;
/** Request headers that describe the hop or carry the caller's credential. */
const DROP = new Set(["host", "connection", "keep-alive", "content-length", "transfer-encoding", "authorization", "x-api-key", "cookie", "proxy-authorization", "te", "upgrade", "forwarded", "x-forwarded-for", "x-forwarded-host", "x-forwarded-proto", "x-real-ip"]);
/** Response headers fetch has already undone. */
const HOP = new Set(["connection", "keep-alive", "content-length", "content-encoding", "transfer-encoding"]);

function send(res: ServerResponse, status: number, value: unknown, extra: Record<string, string> = {}): void {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store", ...extra });
  res.end(JSON.stringify(value));
}

const refuse = (res: ServerResponse, status: number, message: string) => send(res, status, { error: { type: status === 403 ? "permission_error" : "invalid_request", message } });

async function readBody(req: IncomingMessage): Promise<string | null> {
  let raw = "";
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > MAX_BODY) return null;
  }
  return raw;
}

/** The headers to forward, without the box's credential, plus `extra`. */
function forwarded(req: IncomingMessage, extra: Record<string, string>): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(req.headers)) if (!DROP.has(k) && v !== undefined) headers[k] = [v].flat().join(", ");
  return { ...headers, ...extra };
}

async function relay(res: ServerResponse, answer: Response, swap?: [string, string], extra: Record<string, string> = {}): Promise<void> {
  const headers: Record<string, string> = {};
  answer.headers.forEach((v, k) => {
    if (!HOP.has(k)) headers[k] = swap ? v.split(swap[0]).join(swap[1]) : v;
  });
  Object.assign(headers, extra);
  res.writeHead(answer.status, headers);
  res.end(Buffer.from(await answer.arrayBuffer()));
}

/** Start the reference broker for `env`, with a fresh token per box. */
export async function startReferenceBroker(env: BrokerConformanceEnv): Promise<StartedBroker> {
  const tokens: Record<string, string> = Object.fromEntries(env.boxes.map((b) => [b, `box_${randomBytes(32).toString("hex")}`]));
  const boxOf = new Map(Object.entries(tokens).map(([box, token]) => [token, box]));
  const reports = new Map<string, KeptDeclaration>();
  const anthropic = new URL(env.anthropic.url);
  // It spends the operator's one credential for every box, so the payer is shared (#3474), said on the report's answer and on each inference and decide answer.
  const payer: BrokerPayer = { kind: "shared", principal: null };
  const paid = { [PAYER_HEADER]: formatPayerHeader(payer) };
  const fountain = new URL(env.fountain.url);

  const tokenOf = (req: IncomingMessage): string | undefined => {
    const bearer = /^Bearer\s+(\S+)$/i.exec(String(req.headers.authorization ?? ""))?.[1];
    return bearer ?? (typeof req.headers["x-api-key"] === "string" ? req.headers["x-api-key"] : undefined);
  };

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://broker");
      const path = url.pathname;
      const method = req.method ?? "GET";
      const token = tokenOf(req);
      const box = token ? boxOf.get(token) : undefined;
      const raw = await readBody(req);
      if (raw === null) return refuse(res, 413, "The request is larger than 1 MB.");

      if (path === BROKER_ROUTES.declaration) {
        if (method !== "POST") return refuse(res, 405, `POST ${BROKER_ROUTES.declaration}`);
        if (!box) return refuse(res, 403, "This token is no box this broker knows.");
        if (raw.length > DECLARATION_LIMITS.bytes) return refuse(res, 413, "The declaration is larger than 32 KB.");
        let body: unknown;
        try {
          body = JSON.parse(raw);
        } catch {
          return refuse(res, 400, "The body is not JSON.");
        }
        const parsed = parseDeclarationReport(body, env.broker);
        if ("error" in parsed) return refuse(res, 400, parsed.error);
        const kept: KeptDeclaration = { capabilities: parsed.capabilities, at: new Date().toISOString() };
        reports.set(box, kept);
        return send(res, 200, { ...kept, payer });
      }

      let body: unknown;
      try {
        body = raw ? JSON.parse(raw) : undefined;
      } catch {
        body = undefined;
      }
      const request = { method, path, body };
      for (const spec of [INFERENCE_CAPABILITY, EGRESS_CAPABILITY, FEEDBACK_CAPABILITY, FOUNTAIN_CAPABILITY]) {
        if (!spec.routes.some((r) => path === r || path.startsWith(`${r}/`))) continue;
        const words = spec.scopes(request);
        if (words === null) return refuse(res, 404, `This broker does not serve ${method} ${path}.`);
        if (words.length === 0 && spec !== FEEDBACK_CAPABILITY) return send(res, 200, {});
        if (!box) return refuse(res, spec === INFERENCE_CAPABILITY && path === BROKER_ROUTES.decide ? 401 : 403, "This request carried no token of a box this broker knows.");
        if (words.length === 0) return refuse(res, 400, "A batch carries entries (scope agent), counts (scope passive), or both.");
        for (const word of words) {
          const refused = declaredRefusal(reports.get(box), env.broker, spec.name, word);
          if (refused) return refuse(res, 403, refused);
        }

        if (spec === INFERENCE_CAPABILITY && path === BROKER_ROUTES.decide) return decide(res, body);
        if (spec === INFERENCE_CAPABILITY) {
          const rest = path.slice(BROKER_ROUTES.inference.length);
          const answer = await fetch(new URL(`${rest}${url.search}`, anthropic), { method, headers: forwarded(req, { "x-api-key": env.anthropic.credential }), body: raw || undefined });
          return relay(res, answer, undefined, paid);
        }
        if (spec === EGRESS_CAPABILITY) {
          const [name] = words;
          const secret = env.secrets.find((s) => s.box === box && s.name === name);
          if (!secret) return refuse(res, 403, `This broker holds no value for ${name}.`);
          const rest = path.slice(BROKER_ROUTES.egress.length + 1 + name.length) || "/";
          // The box's token stands in for the value wherever the API expects its key, so it is swapped in every header.
          const headers: Record<string, string> = {};
          for (const [k, v] of Object.entries(req.headers)) if (v !== undefined && !HOP.has(k) && k !== "host") headers[k] = [v].flat().join(", ").split(token!).join(secret.value);
          const search = url.search.split(token!).join(secret.value);
          const answer = await fetch(new URL(`${rest}${search}`, secret.host), { method, headers, body: raw || undefined });
          return relay(res, answer, [secret.value, token!]);
        }
        if (spec === FEEDBACK_CAPABILITY) return send(res, 202, { taken: true });
        if (spec === FOUNTAIN_CAPABILITY) {
          const rest = path.slice(BROKER_ROUTES.fountain.length);
          const answer = await fetch(new URL(`${rest}${url.search}`, fountain), { method, headers: forwarded(req, { authorization: `Bearer ${env.fountain.credential}` }), body: raw || undefined });
          return relay(res, answer);
        }
      }
      if (path === BROKER_ROUTES.feedback) return refuse(res, 400, "A batch carries entries (scope agent), counts (scope passive), or both.");
      return refuse(res, 404, "not found");
    } catch (err) {
      if (!res.headersSent) refuse(res, 502, `The broker could not answer: ${err instanceof Error ? err.message : String(err)}`);
    }
  });

  /** One Messages call per question, asking for JSON in a schema made from it, as studio's lobby does. */
  async function decide(res: ServerResponse, body: unknown): Promise<void> {
    const b = body as { model?: unknown; state?: unknown; questions?: Record<string, { type?: string; instructions?: string; criteria?: Record<string, string> }> } | undefined;
    if (!b || typeof b.model !== "string" || b.state === undefined || !b.questions || typeof b.questions !== "object" || Object.keys(b.questions).length === 0) {
      return refuse(res, 422, "The body is { model, state, questions } with at least one question.");
    }
    const answers: Record<string, unknown> = {};
    for (const [name, q] of Object.entries(b.questions)) {
      if (q.type !== "choice" && q.type !== "noul") {
        answers[name] = { type: "unsupported" };
        continue;
      }
      const options = q.type === "noul" ? ["true", "false"] : Object.keys(q.criteria ?? {});
      const schema = {
        type: "object",
        properties: { reason: { type: "string" }, choice: { type: "string", enum: options }, probabilities: { type: "object", properties: Object.fromEntries(options.map((o) => [o, { type: "number" }])) } },
        required: ["reason", "choice", "probabilities"],
      };
      const asked = await fetch(new URL("/v1/messages", anthropic), {
        method: "POST",
        headers: { "content-type": "application/json", "anthropic-version": "2023-06-01", "x-api-key": env.anthropic.credential },
        body: JSON.stringify({ model: b.model, max_tokens: 1024, messages: [{ role: "user", content: `${name}: ${q.instructions}\n${JSON.stringify(b.state)}` }], output_config: { format: { type: "json_schema", schema } } }),
      });
      if (!asked.ok) return refuse(res, 502, `The model answered ${asked.status}.`);
      const message = (await asked.json()) as { content?: { type: string; text?: string }[] };
      const out = JSON.parse(message.content?.find((c) => c.type === "text")?.text ?? "{}") as { reason?: string; choice?: string; probabilities?: Record<string, number> };
      const total = options.reduce((t, o) => t + Number(out.probabilities?.[o] ?? 0), 0) || 1;
      const p = Object.fromEntries(options.map((o) => [o, Number(out.probabilities?.[o] ?? 0) / total]));
      const reason = typeof out.reason === "string" ? { reason: out.reason } : {};
      answers[name] = q.type === "noul" ? { type: "noul", noul: p.true, ...reason } : { type: "choice", choice: out.choice, probabilities: p, confidence: p[out.choice ?? ""] ?? 0, ...reason };
    }
    send(res, 200, { model: b.model, answers }, paid);
  }

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    tokens,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
