/**
 * Broker conformance (#3164, ws-097): the suite a broker of box capabilities
 * runs, such as studio's lobby, fountain's broker or a self-hosted one, to
 * show it serves the broker protocol (`../broker-protocol.ts`).
 *
 * The suite starts the upstreams a broker forwards to: a stand-in for the
 * Anthropic API, one for Fountain's API, and an echo host for egress. It
 * then calls `start(env)`, which starts the broker under test pointed at
 * them, holding `env`'s credentials and secrets, and knowing the boxes
 * `env.boxes` names. The broker returns its base URL and each box's token.
 * The first box reports a declaration before each check; the second never
 * reports. Every request a check makes is the box's, with its token, and
 * every request an upstream receives is recorded.
 *
 * What it holds a broker to, per capability: a declared scope word is
 * served, with the box's token swapped for the credential; an undeclared one
 * is a 403 whose message names the capability and the word; a box that never
 * reported is refused everything; and, over the whole run, no upstream ever
 * saw a box's token and no answer to a box carried a credential or a secret.
 *
 * This module imports no test runner. {@link runBrokerConformance} returns
 * the problems; `describeBrokerConformance` in `./vitest` makes one test per
 * check. The caller passes `listen`, which serves the upstreams: chant
 * itself never listens on a port (ws-052). chant's own test of this suite
 * (`./broker.test.ts`) holds the smallest broker that passes.
 */

import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { BROKER_PROTOCOL_SCHEMA, BROKER_ROUTES, formatPayerHeader, PAYER_HEADER, parsePayerHeader, payerOf, refusalMessage, type BrokerCapabilitySpec } from "../broker-protocol";

/** The capabilities the suite knows how to exercise, in the order it runs them. */
export const BROKER_CONFORMANCE_CAPABILITIES = ["inference", "egress", "feedback", "fountain"] as const;
export type BrokerConformanceCapability = (typeof BROKER_CONFORMANCE_CAPABILITIES)[number];

/** What a studio lobby serves today; the default for `capabilities`. */
export const LOBBY_CAPABILITIES: readonly BrokerConformanceCapability[] = ["inference", "egress", "feedback"];

/** The box that reports its declaration, and the box that never does. */
export const CONFORMANCE_BOXES = ["conformance-a", "conformance-b"] as const;

/** The secret the first box may use through egress, and one it declares that the broker holds no value for. */
export const CONFORMANCE_SECRET = "CONFORMANCE";
export const CONFORMANCE_UNHELD_SECRET = "CONFORMANCE_UNHELD";

/** What the suite gives the broker under test. */
export interface BrokerConformanceEnv {
  /** The broker word the boxes' declarations name, such as `lobby`. The broker keeps only entries naming it. */
  broker: string;
  /** The boxes the broker must know, each with a token it hands back in {@link StartedBroker.tokens}. */
  boxes: readonly string[];
  /** The Anthropic API stand-in: the broker forwards `/llm/anthropic` and asks `/decide` questions here, spending `credential`. */
  anthropic: { url: string; credential: string };
  /** Fountain's API stand-in: the broker forwards `/fountain` here with `credential` as the bearer. */
  fountain: { url: string; credential: string };
  /** The secrets the broker holds: each box's value for a name, and the one host it may be sent to. */
  secrets: readonly { box: string; name: string; host: string; value: string }[];
}

/** The broker under test, started. */
export interface StartedBroker {
  /** Its base URL, as a box is given it. */
  url: string;
  /** Each box's own token, by the names in {@link BrokerConformanceEnv.boxes}. */
  tokens: Record<string, string>;
  close?(): Promise<void> | void;
}

/** A capability a lexicon or runtime adds, and how the suite asks for one of its scope words. */
export interface ExtraCapability {
  spec: BrokerCapabilitySpec;
  /** Scope words to check, each served when declared and refused when not. */
  words: readonly string[];
  /** A request that needs exactly `word`. */
  probe(word: string): { method: string; path: string; headers?: Record<string, string>; body?: unknown };
}

export interface BrokerConformanceConfig {
  /** The broker's name in the report. */
  name: string;
  start(env: BrokerConformanceEnv): Promise<StartedBroker> | StartedBroker;
  /** Serves the suite's upstreams on loopback ports; see {@link BrokerListen}. */
  listen: BrokerListen;
  /** The broker word, `lobby` when omitted. */
  broker?: string;
  /** The standard capabilities it serves, {@link LOBBY_CAPABILITIES} when omitted. The rest are reported as skipped. */
  capabilities?: readonly BrokerConformanceCapability[];
  /** Capabilities beyond the standard ones, held to the same rule. */
  extra?: readonly ExtraCapability[];
  /** How long one request may take, 15 s when omitted. */
  timeoutMs?: number;
}

/** One check's outcome. */
export interface BrokerCheckResult {
  id: string;
  capability: string;
  title: string;
  problems: string[];
  /** Why it did not run, when it did not. */
  skipped?: string;
}

export interface BrokerConformanceReport {
  name: string;
  broker: string;
  results: BrokerCheckResult[];
  /** Every problem, each as `<check id>: <problem>`. Empty when the broker conforms. */
  problems: string[];
}

/** One request an upstream received. */
export interface UpstreamRequest {
  upstream: "anthropic" | "fountain" | "egress";
  method: string;
  /** The path and query as received. */
  url: string;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

/** One answer the broker gave a box. */
export interface BoxAnswer {
  status: number;
  headers: Record<string, string>;
  text: string;
  json: unknown;
}

export interface BrokerCheck {
  id: string;
  capability: BrokerConformanceCapability | "declaration" | "all" | string;
  title: string;
  run(ctx: BrokerConformanceContext): Promise<string[]>;
}

/** What a check runs with: the env, the broker, every upstream request and every answer so far, and helpers. */
export interface BrokerConformanceContext {
  env: BrokerConformanceEnv;
  broker: StartedBroker;
  served: readonly string[];
  upstream: UpstreamRequest[];
  answers: BoxAnswer[];
  call(box: string | null, method: string, path: string, opts?: { headers?: Record<string, string>; body?: unknown; token?: string; auth?: "bearer" | "x-api-key" | "none" }): Promise<BoxAnswer>;
  report(capabilities: { name: string; broker: string | null; scope: string[] }[]): Promise<BoxAnswer>;
  validate(def: string, value: unknown): string[];
}

const HERE = dirname(fileURLToPath(import.meta.url));

export type BrokerSchemaValidate = ((value: unknown) => boolean) & { errors?: { instancePath: string; message?: string }[] | null };
let validators: ((def: string) => BrokerSchemaValidate) | undefined;

/** A validator for one `$defs` entry of the protocol's schema, from this package's own ajv 8. */
export function brokerSchemaValidator(def: string): BrokerSchemaValidate {
  if (!validators) {
    const schema = JSON.parse(readFileSync(join(HERE, "..", BROKER_PROTOCOL_SCHEMA), "utf-8")) as { $id: string };
    const mod = createRequire(import.meta.url)("ajv/dist/2020") as { default?: unknown };
    const Ajv = (mod.default ?? mod) as new (opts: object) => { addSchema(s: object): void; getSchema(ref: string): BrokerSchemaValidate | undefined };
    const ajv = new Ajv({ strict: true, allErrors: true, allowUnionTypes: true });
    ajv.addSchema(schema);
    validators = (name) => {
      const v = ajv.getSchema(`${schema.$id}#/$defs/${name}`);
      if (!v) throw new Error(`${BROKER_PROTOCOL_SCHEMA} has no $defs/${name}`);
      return v;
    };
  }
  return validators(def);
}

const hex = (n = 16) => randomBytes(n).toString("hex");

async function readBody(req: IncomingMessage): Promise<string> {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  return raw;
}

/** A request handler, as `node:http`'s `createServer` takes one. */
export type BrokerHttpHandler = (req: IncomingMessage, res: ServerResponse) => void;

/**
 * How the suite serves its upstreams: serve `handler` on a loopback port and
 * return its URL and how to stop it. The caller passes it because chant
 * itself never listens on a port (ws-052, ws-086, test/no-listener.test.ts);
 * the test that runs the suite does.
 */
export type BrokerListen = (handler: BrokerHttpHandler) => Promise<{ url: string; close(): Promise<void> | void }>;

/** An instance of a JSON Schema, enough to answer a structured-output request: the first enum, an even split of numbers. */
export function schemaInstance(schema: unknown): unknown {
  const s = (schema ?? {}) as { type?: unknown; enum?: unknown[]; const?: unknown; properties?: Record<string, unknown>; items?: unknown };
  if ("const" in s) return s.const;
  if (Array.isArray(s.enum) && s.enum.length > 0) return s.enum[0];
  const type = Array.isArray(s.type) ? s.type[0] : s.type;
  if (type === "object" || s.properties) {
    const props = Object.entries(s.properties ?? {});
    const numbers = props.filter(([, p]) => (p as { type?: unknown })?.type === "number").length;
    return Object.fromEntries(props.map(([k, p]) => [k, (p as { type?: unknown })?.type === "number" ? Math.round((1 / Math.max(numbers, 1)) * 1e6) / 1e6 : schemaInstance(p)]));
  }
  if (type === "array") return [];
  if (type === "number" || type === "integer") return 0.5;
  if (type === "boolean") return true;
  if (type === "string") return "The conformance upstream's reason.";
  return null;
}

/** The Anthropic API stand-in: a Messages API answer, structured when the request asks for a schema. */
function anthropicAnswer(req: UpstreamRequest, res: ServerResponse): void {
  const path = req.url.split("?")[0];
  const send = (status: number, value: unknown) => {
    res.writeHead(status, { "content-type": "application/json", "request-id": "req_conformance" });
    res.end(JSON.stringify(value));
  };
  if (req.method === "POST" && path === "/v1/messages") {
    let body: { model?: string; output_config?: { format?: { schema?: unknown } } } = {};
    try {
      body = JSON.parse(req.body);
    } catch {}
    const schema = body.output_config?.format?.schema;
    const text = schema ? JSON.stringify(schemaInstance(schema)) : "conformance";
    return send(200, { id: "msg_conformance", type: "message", role: "assistant", model: body.model ?? "claude-conformance", content: [{ type: "text", text }], stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 } });
  }
  if (req.method === "POST" && path === "/v1/messages/count_tokens") return send(200, { input_tokens: 1 });
  if (req.method === "GET" && path.startsWith("/v1/models")) return send(200, { data: [{ id: "claude-conformance", type: "model" }] });
  send(404, { type: "error", error: { type: "not_found_error", message: "not here" } });
}

/** The upstreams, recording every request. */
/** The upstreams' handlers, each recording every request it receives in `log`. */
export function upstreamHandlers(log: UpstreamRequest[]): { anthropic: BrokerHttpHandler; fountain: BrokerHttpHandler; egress: BrokerHttpHandler } {
  const make =
    (upstream: UpstreamRequest["upstream"], answer: (r: UpstreamRequest, res: ServerResponse) => void): BrokerHttpHandler =>
    (req, res) => {
      void readBody(req).then((body) => {
        const r: UpstreamRequest = { upstream, method: req.method ?? "GET", url: req.url ?? "/", headers: { ...req.headers }, body };
        log.push(r);
        answer(r, res);
      });
    };
  const [anthropic, fountain, egress] = [
    make("anthropic", anthropicAnswer),
    make("fountain", (r, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ path: r.url }));
    }),
    // The egress host repeats the authorization it was sent in a header, as an API that echoes its key would.
    make("egress", (r, res) => {
      res.writeHead(200, { "content-type": "application/json", "x-conformance-echo": String(r.headers.authorization ?? "") });
      res.end(JSON.stringify({ path: r.url }));
    }),
  ];
  return { anthropic, fountain, egress };
}

async function startUpstreams(log: UpstreamRequest[], listen: BrokerListen): Promise<{ anthropic: string; fountain: string; egress: string; close(): Promise<void> }> {
  const handlers = upstreamHandlers(log);
  const served = await Promise.all([listen(handlers.anthropic), listen(handlers.fountain), listen(handlers.egress)]);
  return {
    anthropic: served[0].url,
    fountain: served[1].url,
    egress: served[2].url,
    close: async () => {
      await Promise.all(served.map((s) => s.close()));
    },
  };
}

/** The problems with a refusal: not `status`, not a refusal body, or a message that does not name each of `names`. */
function refusalProblems(answer: BoxAnswer, names: string[], status: number | number[] = 403): string[] {
  const ok = [status].flat();
  const problems: string[] = [];
  if (!ok.includes(answer.status)) problems.push(`expected ${ok.join(" or ")}, got ${answer.status}: ${answer.text.slice(0, 200)}`);
  const message = refusalMessage(answer.json);
  if (message === undefined) problems.push(`the refusal's body is not { "error": "<message>" } or { "error": { "message" } }: ${answer.text.slice(0, 200)}`);
  else for (const n of names) if (!message.includes(n)) problems.push(`the refusal's message does not name ${n}: ${message}`);
  return problems;
}

function untouched(ctx: BrokerConformanceContext, before: number, what: string): string[] {
  const after = ctx.upstream.slice(before);
  return after.length === 0 ? [] : [`${what}, and the broker forwarded it anyway: ${after.map((r) => `${r.upstream} ${r.method} ${r.url}`).join(", ")}`];
}

const declare = (ctx: BrokerConformanceContext, caps: [string, string[]][], others: { name: string; broker: string | null; scope: string[] }[] = []) =>
  ctx.report([...caps.map(([name, scope]) => ({ name, broker: ctx.env.broker, scope })), ...others]);

async function declared(ctx: BrokerConformanceContext, caps: [string, string[]][]): Promise<string[]> {
  const r = await declare(ctx, caps);
  return r.status === 200 ? [] : [`reporting the declaration failed with ${r.status}: ${r.text.slice(0, 200)}`];
}

const A = CONFORMANCE_BOXES[0];
const B = CONFORMANCE_BOXES[1];

const MESSAGE = { model: "claude-conformance", max_tokens: 16, messages: [{ role: "user", content: "conformance" }] };
const DECIDE = {
  model: "claude-conformance",
  state: { change: "conformance" },
  questions: {
    "conformance-tier": { type: "choice", instructions: "Pick the tier.", criteria: { small: "a small change", large: "a large change" } },
    "conformance-ship": { type: "noul", instructions: "Ship it?", criteria: { true: "ship", false: "hold" } },
  },
};

/** Every check, in the order it runs. */
export const BROKER_CHECKS: readonly BrokerCheck[] = [
  {
    id: "declaration-kept",
    capability: "declaration",
    title: "a report is answered 200 with the entries that name this broker, and none that name another or no broker",
    async run(ctx) {
      const r = await declare(ctx, [["inference", ["agent", "decide"]]], [{ name: "elsewhere", broker: `not-${ctx.env.broker}`, scope: ["x"] }, { name: "unbrokered", broker: null, scope: ["x"] }]);
      if (r.status !== 200) return [`expected 200, got ${r.status}: ${r.text.slice(0, 200)}`];
      const problems = ctx.validate("declarationKept", r.json);
      const kept = (r.json as { capabilities?: { name: string; scope: string[] }[] }).capabilities ?? [];
      if (kept.some((c) => c.name === "elsewhere")) problems.push("it kept an entry that names another broker");
      if (kept.some((c) => c.name === "unbrokered")) problems.push("it kept an entry that names no broker");
      const inference = kept.filter((c) => c.name === "inference");
      if (inference.length !== 1) problems.push(`it kept inference ${inference.length} times`);
      else if (!isDeepStrictEqual([...inference[0].scope].sort(), ["agent", "decide"])) problems.push(`it kept inference's scope as ${JSON.stringify(inference[0].scope)}, not agent and decide`);
      return problems;
    },
  },
  {
    id: "declaration-unknown-token",
    capability: "declaration",
    title: "a report with no token, or one that is no box's, is refused with a 401 or 403",
    async run(ctx) {
      const body = { capabilities: [] };
      const problems: string[] = [];
      for (const [what, token, auth] of [["no token", undefined, "none"], ["an unknown token", `unknown-${hex()}`, "bearer"]] as const) {
        const r = await ctx.call(null, "POST", BROKER_ROUTES.declaration, { body, token, auth });
        problems.push(...refusalProblems(r, [], [401, 403]).map((p) => `${what}: ${p}`));
      }
      return problems;
    },
  },
  {
    id: "declaration-malformed",
    capability: "declaration",
    title: "a report that is not { capabilities: [...] } is refused with a 400",
    async run(ctx) {
      const r = await ctx.call(A, "POST", BROKER_ROUTES.declaration, { body: { capability: [] } });
      return refusalProblems(r, [], 400);
    },
  },
  {
    id: "unreported-refused",
    capability: "declaration",
    title: "a box that has never reported is refused every capability with a 403",
    async run(ctx) {
      const probes: [string, string, string, object?][] = [];
      if (ctx.served.includes("inference")) probes.push(["inference agent", "POST", `${BROKER_ROUTES.inference}/v1/messages`, MESSAGE], ["inference decide", "POST", BROKER_ROUTES.decide, DECIDE]);
      if (ctx.served.includes("egress")) probes.push(["egress", "GET", `${BROKER_ROUTES.egress}/${CONFORMANCE_SECRET}/v1/echo`]);
      if (ctx.served.includes("feedback")) probes.push(["feedback", "POST", BROKER_ROUTES.feedback, { entries: [{ note: "conformance" }] }]);
      if (ctx.served.includes("fountain")) probes.push(["fountain", "GET", `${BROKER_ROUTES.fountain}/api/conversations`]);
      const problems: string[] = [];
      const before = ctx.upstream.length;
      for (const [what, method, path, body] of probes) {
        const r = await ctx.call(B, method, path, { body, auth: what === "inference agent" ? "x-api-key" : "bearer" });
        problems.push(...refusalProblems(r, []).map((p) => `${what}: ${p}`));
      }
      return [...problems, ...untouched(ctx, before, "the box never reported")];
    },
  },
  {
    id: "inference-hello",
    capability: "inference",
    title: "HEAD /llm/anthropic/api/hello is answered 200 without a token, as the Anthropic client probes it",
    async run(ctx) {
      const r = await ctx.call(null, "HEAD", `${BROKER_ROUTES.inference}/api/hello`, { auth: "none" });
      return r.status === 200 ? [] : [`expected 200, got ${r.status}`];
    },
  },
  {
    id: "inference-forwards",
    capability: "inference",
    title: "with agent declared, a Messages call reaches the upstream unchanged with the credential in place of the box's token, and its answer comes back",
    async run(ctx) {
      const problems = await declared(ctx, [["inference", ["agent"]]]);
      const before = ctx.upstream.length;
      const r = await ctx.call(A, "POST", `${BROKER_ROUTES.inference}/v1/messages?beta=true`, { body: MESSAGE, auth: "x-api-key", headers: { "anthropic-version": "2023-06-01" } });
      if (r.status !== 200) return [...problems, `expected 200, got ${r.status}: ${r.text.slice(0, 200)}`];
      const sent = ctx.upstream.slice(before).filter((u) => u.upstream === "anthropic");
      if (sent.length !== 1) return [...problems, `the upstream received ${sent.length} requests, not 1`];
      const [u] = sent;
      if (u.method !== "POST" || u.url !== "/v1/messages?beta=true") problems.push(`the upstream received ${u.method} ${u.url}, not POST /v1/messages?beta=true`);
      const credential = ctx.env.anthropic.credential;
      if (u.headers["x-api-key"] !== credential && u.headers.authorization !== `Bearer ${credential}`) problems.push("the upstream request did not carry the credential as x-api-key or a bearer");
      let body: unknown;
      try {
        body = JSON.parse(u.body);
      } catch {}
      if (!isDeepStrictEqual(body, MESSAGE)) problems.push("the upstream received a different body than the box sent");
      if ((r.json as { id?: unknown })?.id !== "msg_conformance") problems.push("the answer is not the upstream's");
      return problems;
    },
  },
  {
    id: "inference-unknown-route",
    capability: "inference",
    title: "a path the proxy does not forward is a 404 and reaches no upstream",
    async run(ctx) {
      const problems = await declared(ctx, [["inference", ["agent"]]]);
      const before = ctx.upstream.length;
      const r = await ctx.call(A, "POST", `${BROKER_ROUTES.inference}/v1/complete`, { body: MESSAGE, auth: "x-api-key" });
      if (r.status !== 404) problems.push(`expected 404, got ${r.status}`);
      return [...problems, ...untouched(ctx, before, "the path is not one the proxy forwards")];
    },
  },
  {
    id: "inference-unknown-token",
    capability: "inference",
    title: "a Messages call with no box's token is a 403, never a 401 (the Anthropic client retries a 401), and reaches no upstream",
    async run(ctx) {
      const before = ctx.upstream.length;
      const r = await ctx.call(null, "POST", `${BROKER_ROUTES.inference}/v1/messages`, { body: MESSAGE, token: `unknown-${hex()}`, auth: "x-api-key" });
      return [...refusalProblems(r, []), ...untouched(ctx, before, "the token is no box's")];
    },
  },
  {
    id: "inference-agent-refused",
    capability: "inference",
    title: "without agent in inference's scope, a Messages call is a 403 naming inference and agent",
    async run(ctx) {
      const problems = await declared(ctx, [["inference", ["decide"]]]);
      const before = ctx.upstream.length;
      const r = await ctx.call(A, "POST", `${BROKER_ROUTES.inference}/v1/messages`, { body: MESSAGE, auth: "x-api-key" });
      return [...problems, ...refusalProblems(r, ["inference", "agent"]), ...untouched(ctx, before, "agent is not declared")];
    },
  },
  {
    id: "decide-answers",
    capability: "inference",
    title: "with decide declared, /decide/v1/systemone answers every question in the wire format, naming the model asked",
    async run(ctx) {
      const problems = await declared(ctx, [["inference", ["decide"]]]);
      const before = ctx.upstream.length;
      const r = await ctx.call(A, "POST", BROKER_ROUTES.decide, { body: DECIDE });
      if (r.status !== 200) return [...problems, `expected 200, got ${r.status}: ${r.text.slice(0, 200)}`];
      problems.push(...ctx.validate("decideResponse", r.json));
      const answer = r.json as { model?: string; answers?: Record<string, { type?: string }> };
      if (answer.model !== DECIDE.model) problems.push(`the answer names the model ${answer.model}, not ${DECIDE.model} as asked`);
      for (const [name, q] of Object.entries(DECIDE.questions)) {
        const a = answer.answers?.[name];
        if (!a) problems.push(`no answer for ${name}`);
        else if (a.type !== q.type && a.type !== "unsupported") problems.push(`${name} is a ${q.type} question and was answered ${a.type}`);
      }
      const credential = ctx.env.anthropic.credential;
      for (const u of ctx.upstream.slice(before).filter((u) => u.upstream === "anthropic")) {
        if (u.headers["x-api-key"] !== credential && u.headers.authorization !== `Bearer ${credential}`) problems.push(`the upstream call ${u.method} ${u.url} did not carry the credential`);
      }
      return problems;
    },
  },
  {
    id: "decide-refused",
    capability: "inference",
    title: "without decide in inference's scope, /decide is a 403 naming inference and decide",
    async run(ctx) {
      const problems = await declared(ctx, [["inference", ["agent"]]]);
      const before = ctx.upstream.length;
      const r = await ctx.call(A, "POST", BROKER_ROUTES.decide, { body: DECIDE });
      return [...problems, ...refusalProblems(r, ["inference", "decide"]), ...untouched(ctx, before, "decide is not declared")];
    },
  },
  {
    id: "decide-invalid",
    capability: "inference",
    title: "a decide request that is not in the wire format is a 422 and asks no model",
    async run(ctx) {
      const problems = await declared(ctx, [["inference", ["decide"]]]);
      const before = ctx.upstream.length;
      const r = await ctx.call(A, "POST", BROKER_ROUTES.decide, { body: { model: DECIDE.model, state: {}, questions: {} } });
      return [...problems, ...refusalProblems(r, [], 422), ...untouched(ctx, before, "the request names no question")];
    },
  },
  {
    id: "decide-unknown-token",
    capability: "inference",
    title: "a decide request with no box's token is a 401 or 403",
    async run(ctx) {
      const r = await ctx.call(null, "POST", BROKER_ROUTES.decide, { body: DECIDE, token: `unknown-${hex()}` });
      return refusalProblems(r, [], [401, 403]);
    },
  },
  {
    id: "egress-forwards",
    capability: "egress",
    title: "with the secret declared, /egress/NAME/... reaches only the secret's host with the value in place of the box's token, and the value never comes back",
    async run(ctx) {
      const problems = await declared(ctx, [["egress", [CONFORMANCE_SECRET]]]);
      const before = ctx.upstream.length;
      const token = ctx.broker.tokens[A];
      const r = await ctx.call(A, "GET", `${BROKER_ROUTES.egress}/${CONFORMANCE_SECRET}/v1/echo?q=1`);
      if (r.status !== 200) return [...problems, `expected 200, got ${r.status}: ${r.text.slice(0, 200)}`];
      const sent = ctx.upstream.slice(before);
      if (sent.length !== 1 || sent[0].upstream !== "egress") return [...problems, `expected one request to the secret's host, got ${sent.map((u) => `${u.upstream} ${u.url}`).join(", ") || "none"}`];
      const value = ctx.env.secrets.find((s) => s.box === A && s.name === CONFORMANCE_SECRET)!.value;
      if (sent[0].url !== "/v1/echo?q=1") problems.push(`the host received ${sent[0].url}, not /v1/echo?q=1`);
      if (sent[0].headers.authorization !== `Bearer ${value}`) problems.push("the host did not receive the secret's value where the box put its token");
      if (r.headers["x-conformance-echo"] !== `Bearer ${token}`) problems.push("the host's header repeating the value did not come back to the box with its token in the value's place");
      return problems;
    },
  },
  {
    id: "egress-refused",
    capability: "egress",
    title: "a secret the egress scope does not list is a 403 naming egress and the secret, and reaches no host",
    async run(ctx) {
      const problems = await declared(ctx, [["egress", ["CONFORMANCE_OTHER"]]]);
      const before = ctx.upstream.length;
      const r = await ctx.call(A, "GET", `${BROKER_ROUTES.egress}/${CONFORMANCE_SECRET}/v1/echo`);
      return [...problems, ...refusalProblems(r, ["egress", CONFORMANCE_SECRET]), ...untouched(ctx, before, "the secret is not declared")];
    },
  },
  {
    id: "egress-unheld",
    capability: "egress",
    title: "a declared secret the broker holds no value for is a 403, and reaches no host",
    async run(ctx) {
      const problems = await declared(ctx, [["egress", [CONFORMANCE_SECRET, CONFORMANCE_UNHELD_SECRET]]]);
      const before = ctx.upstream.length;
      const r = await ctx.call(A, "GET", `${BROKER_ROUTES.egress}/${CONFORMANCE_UNHELD_SECRET}/v1/echo`);
      return [...problems, ...refusalProblems(r, [CONFORMANCE_UNHELD_SECRET]), ...untouched(ctx, before, "the broker holds no value for the secret")];
    },
  },
  {
    id: "egress-bad-name",
    capability: "egress",
    title: "an egress path whose name is not a secret's name is a 404",
    async run(ctx) {
      const problems = await declared(ctx, [["egress", [CONFORMANCE_SECRET]]]);
      const before = ctx.upstream.length;
      const r = await ctx.call(A, "GET", `${BROKER_ROUTES.egress}/conformance/v1/echo`);
      if (r.status !== 404) problems.push(`expected 404, got ${r.status}`);
      return [...problems, ...untouched(ctx, before, "the path names no secret")];
    },
  },
  {
    id: "feedback-taken",
    capability: "feedback",
    title: "with agent in feedback's scope, a batch of entries passes the declaration: not a 401 or 403",
    async run(ctx) {
      const problems = await declared(ctx, [["feedback", ["agent"]]]);
      const r = await ctx.call(A, "POST", BROKER_ROUTES.feedback, { body: { entries: [{ note: "conformance" }] } });
      if (r.status === 401 || r.status === 403) problems.push(`the batch was refused with ${r.status}: ${r.text.slice(0, 200)}`);
      return problems;
    },
  },
  {
    id: "feedback-refused",
    capability: "feedback",
    title: "counts without passive in feedback's scope are a 403 naming feedback and passive",
    async run(ctx) {
      const problems = await declared(ctx, [["feedback", ["agent"]]]);
      const r = await ctx.call(A, "POST", BROKER_ROUTES.feedback, { body: { counts: { refusals: 1 } } });
      return [...problems, ...refusalProblems(r, ["feedback", "passive"])];
    },
  },
  {
    id: "feedback-empty",
    capability: "feedback",
    title: "a batch with neither entries nor counts is a 400",
    async run(ctx) {
      const problems = await declared(ctx, [["feedback", ["agent", "passive"]]]);
      const r = await ctx.call(A, "POST", BROKER_ROUTES.feedback, { body: {} });
      return [...problems, ...refusalProblems(r, [], 400)];
    },
  },
  {
    id: "fountain-forwards",
    capability: "fountain",
    title: "with conversations declared, /fountain/api/conversations/... reaches Fountain with the operator's key in place of the box's token",
    async run(ctx) {
      const problems = await declared(ctx, [["fountain", ["conversations"]]]);
      const before = ctx.upstream.length;
      const r = await ctx.call(A, "GET", `${BROKER_ROUTES.fountain}/api/conversations/conformance`);
      if (r.status !== 200) return [...problems, `expected 200, got ${r.status}: ${r.text.slice(0, 200)}`];
      const sent = ctx.upstream.slice(before);
      if (sent.length !== 1 || sent[0].upstream !== "fountain") return [...problems, `expected one request to Fountain, got ${sent.length}`];
      if (sent[0].url !== "/api/conversations/conformance") problems.push(`Fountain received ${sent[0].url}`);
      if (sent[0].headers.authorization !== `Bearer ${ctx.env.fountain.credential}`) problems.push("Fountain did not receive the operator's key as the bearer");
      return problems;
    },
  },
  {
    id: "fountain-refused",
    capability: "fountain",
    title: "without sandboxes in fountain's scope, /fountain/api/sandboxes is a 403 naming fountain and sandboxes",
    async run(ctx) {
      const problems = await declared(ctx, [["fountain", ["conversations"]]]);
      const before = ctx.upstream.length;
      const r = await ctx.call(A, "GET", `${BROKER_ROUTES.fountain}/api/sandboxes`);
      return [...problems, ...refusalProblems(r, ["fountain", "sandboxes"]), ...untouched(ctx, before, "sandboxes is not declared")];
    },
  },
  {
    id: "payer-consistent",
    capability: "inference",
    title: "a payer, when the broker says one (#3474), is well formed and the same on the declaration's answer and on a Messages answer's chant-payer header",
    async run(ctx) {
      const r = await declare(ctx, [["inference", ["agent"]]]);
      if (r.status !== 200) return [`reporting the declaration failed with ${r.status}: ${r.text.slice(0, 200)}`];
      const problems: string[] = [];
      const raw = (r.json as { payer?: unknown } | null)?.payer;
      const kept = payerOf(r.json);
      if (raw !== undefined && !kept) problems.push(`the declaration's answer carries a payer the protocol does not know: ${JSON.stringify(raw)}`);
      const m = await ctx.call(A, "POST", `${BROKER_ROUTES.inference}/v1/messages`, { body: MESSAGE, auth: "x-api-key", headers: { "anthropic-version": "2023-06-01" } });
      if (m.status !== 200) return [...problems, `expected 200 from a Messages call, got ${m.status}: ${m.text.slice(0, 200)}`];
      const header = m.headers[PAYER_HEADER];
      const relayed = parsePayerHeader(header);
      if (header !== undefined && !relayed) problems.push(`the ${PAYER_HEADER} header names no payer the protocol knows: ${JSON.stringify(header)}`);
      if ((raw === undefined) !== (header === undefined)) problems.push(`the payer is said on ${raw === undefined ? `the ${PAYER_HEADER} header` : "the declaration's answer"} only; a broker that says it says it on both`);
      else if (kept && relayed && (kept.kind !== relayed.kind || (kept.principal ?? null) !== (relayed.principal ?? null))) {
        problems.push(`the declaration's answer says ${formatPayerHeader(kept)} and the Messages answer says ${formatPayerHeader(relayed)}`);
      }
      return problems;
    },
  },
];

/** The last check: over every request of the run, no box token went upstream and no credential or secret came back. */
const ISOLATION: BrokerCheck = {
  id: "token-isolation",
  capability: "all",
  title: "no upstream ever received a box's token, and no answer to a box carried a credential or a secret's value",
  async run(ctx) {
    const problems: string[] = [];
    const tokens = Object.values(ctx.broker.tokens);
    for (const u of ctx.upstream) {
      const seen = [u.url, u.body, ...Object.values(u.headers).flat().map(String)].join("\n");
      for (const t of tokens) if (seen.includes(t)) problems.push(`${u.upstream} received a box's token in ${u.method} ${u.url}`);
    }
    const secrets = [ctx.env.anthropic.credential, ctx.env.fountain.credential, ...ctx.env.secrets.map((s) => s.value)];
    for (const a of ctx.answers) {
      const seen = [a.text, ...Object.values(a.headers)].join("\n");
      for (const s of secrets) if (seen.includes(s)) problems.push(`an answer to a box (status ${a.status}) carried a credential or a secret's value`);
    }
    return [...new Set(problems)];
  },
};

function extraChecks(extra: ExtraCapability): BrokerCheck[] {
  return extra.words.flatMap((word): BrokerCheck[] => [
    {
      id: `${extra.spec.name}-${word}-served`,
      capability: extra.spec.name,
      title: `with ${word} in ${extra.spec.name}'s scope, a request that needs it is not refused by the declaration`,
      async run(ctx) {
        const problems = await declared(ctx, [[extra.spec.name, [word]]]);
        const p = extra.probe(word);
        const r = await ctx.call(A, p.method, p.path, { headers: p.headers, body: p.body });
        if (r.status === 401 || r.status === 403) problems.push(`refused with ${r.status}: ${r.text.slice(0, 200)}`);
        return problems;
      },
    },
    {
      id: `${extra.spec.name}-${word}-refused`,
      capability: extra.spec.name,
      title: `without ${word} in ${extra.spec.name}'s scope, the request is a 403 naming ${extra.spec.name} and ${word}`,
      async run(ctx) {
        const problems = await declared(ctx, [[extra.spec.name, []]]);
        const p = extra.probe(word);
        const r = await ctx.call(A, p.method, p.path, { headers: p.headers, body: p.body });
        return [...problems, ...refusalProblems(r, [extra.spec.name, word])];
      },
    },
  ]);
}

/** The checks a config runs, and the ones it skips with why. */
export function brokerChecks(config: Pick<BrokerConformanceConfig, "capabilities" | "extra">): { check: BrokerCheck; skipped?: string }[] {
  const served = config.capabilities ?? LOBBY_CAPABILITIES;
  return [
    ...BROKER_CHECKS.map((check) => ({
      check,
      skipped: check.capability === "declaration" || served.includes(check.capability as BrokerConformanceCapability) ? undefined : `the broker does not serve ${check.capability}`,
    })),
    ...(config.extra ?? []).flatMap(extraChecks).map((check) => ({ check })),
    { check: ISOLATION },
  ];
}

/** A run of the suite: the upstreams and the broker started, and a context to run checks in. Close it when done. */
export async function startBrokerConformance(config: BrokerConformanceConfig): Promise<{ ctx: BrokerConformanceContext; close(): Promise<void> }> {
  const upstream: UpstreamRequest[] = [];
  const answers: BoxAnswer[] = [];
  const ups = await startUpstreams(upstream, config.listen);
  const broker = config.broker ?? "lobby";
  const env: BrokerConformanceEnv = {
    broker,
    boxes: CONFORMANCE_BOXES,
    anthropic: { url: ups.anthropic, credential: `sk-ant-api03-conformance-${hex(24)}` },
    fountain: { url: ups.fountain, credential: `fountain-conformance-${hex(24)}` },
    secrets: [{ box: A, name: CONFORMANCE_SECRET, host: ups.egress, value: `conformance-secret-${hex(24)}` }],
  };
  let started: StartedBroker;
  try {
    started = await config.start(env);
  } catch (err) {
    await ups.close();
    throw err;
  }
  for (const box of CONFORMANCE_BOXES) if (!started.tokens[box]) {
    await started.close?.();
    await ups.close();
    throw new Error(`the broker returned no token for ${box}`);
  }
  const timeoutMs = config.timeoutMs ?? 15_000;
  const base = started.url.replace(/\/+$/, "");
  const ctx: BrokerConformanceContext = {
    env,
    broker: started,
    served: config.capabilities ?? LOBBY_CAPABILITIES,
    upstream,
    answers,
    async call(box, method, path, opts = {}) {
      const token = opts.token ?? (box ? started.tokens[box] : undefined);
      const headers: Record<string, string> = { ...(opts.headers ?? {}) };
      const auth = opts.auth ?? "bearer";
      if (token && auth === "bearer") headers.authorization = `Bearer ${token}`;
      if (token && auth === "x-api-key") headers["x-api-key"] = token;
      let body: string | undefined;
      if (opts.body !== undefined) {
        body = JSON.stringify(opts.body);
        headers["content-type"] ??= "application/json";
      }
      const res = await fetch(`${base}${path}`, { method, headers, body, redirect: "manual", signal: AbortSignal.timeout(timeoutMs) });
      const text = method === "HEAD" ? "" : await res.text();
      let json: unknown;
      try {
        json = text ? JSON.parse(text) : undefined;
      } catch {}
      const got: Record<string, string> = {};
      res.headers.forEach((v, k) => {
        got[k] = v;
      });
      const answer: BoxAnswer = { status: res.status, headers: got, text, json };
      answers.push(answer);
      return answer;
    },
    report(capabilities) {
      return ctx.call(A, "POST", BROKER_ROUTES.declaration, { body: { capabilities } });
    },
    validate(def, value) {
      const v = brokerSchemaValidator(def);
      return v(value) ? [] : (v.errors ?? []).map((e) => `the body does not match ${def}: ${e.instancePath || "/"} ${e.message ?? ""}`.trim());
    },
  };
  return {
    ctx,
    async close() {
      await started.close?.();
      await ups.close();
    },
  };
}

/** Run one check, catching what it throws as its problem. */
export async function runBrokerCheck(ctx: BrokerConformanceContext, check: BrokerCheck): Promise<string[]> {
  try {
    return await check.run(ctx);
  } catch (err) {
    return [`the check threw: ${err instanceof Error ? err.message : String(err)}`];
  }
}

/** Run the whole suite against a broker, and return the report. */
export async function runBrokerConformance(config: BrokerConformanceConfig): Promise<BrokerConformanceReport> {
  const run = await startBrokerConformance(config);
  const results: BrokerCheckResult[] = [];
  try {
    for (const { check, skipped } of brokerChecks(config)) {
      results.push({ id: check.id, capability: check.capability, title: check.title, problems: skipped ? [] : await runBrokerCheck(run.ctx, check), ...(skipped ? { skipped } : {}) });
    }
  } finally {
    await run.close();
  }
  return {
    name: config.name,
    broker: config.broker ?? "lobby",
    results,
    problems: results.flatMap((r) => r.problems.map((p) => `${r.id}: ${p}`)),
  };
}
