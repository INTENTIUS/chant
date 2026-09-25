/**
 * The client for the `POST /v1/systemone` wire format (#2491): TypeSafe's Jev
 * API, and every server that implements the same request and response.
 *
 * ```
 * POST <url>/v1/systemone          Authorization: Bearer <key>
 * { "model": "jev-1.13.0", "state": {...}, "questions": { "<name>": { "type": "noul" | "choice" | "score", "instructions": ..., "criteria": ... } } }
 *
 * { "model": "jev-1.13.0", "answers": { "<name>": { "type": "noul", "noul": 0.22 } | { "type": "choice", "choice": ..., "probabilities": {...}, "confidence": ... } | { "type": "score", ... } } }
 * ```
 *
 * {@link systemoneAsk} turns a set of backends into core's `ModelAsk`, the
 * model call `askPoint` takes (`@intentius/chant/workspace/points`). This file
 * only speaks the wire format: whether an answer is observed, proposed or
 * escalated, and what a point does when the backend is unreachable, are
 * core's (`runChain`), so they are the same for this client, for a response
 * handed to `points ask --response`, and for any runtime's decider.
 *
 * The model id is sent as the point pins it. An alias such as `jev-latest` is
 * refused where the point is declared, and the response's `model` is compared
 * with the pin by core, so an alias that moved is never recorded as the pin.
 *
 * Anything that stops an answer arriving throws: no key, a network error, a
 * timeout, a non-2xx status (Jev's are 401, 422, 429 and 529), or a response
 * without an answer to the question asked. Core reads a throw as the backend
 * being unreachable and follows the point's `unreachable`.
 */

import type { ModelAsk, ModelRequest, WireAnswer } from "@intentius/chant/workspace/points";
import { readDeclaration } from "@intentius/chant/workspace/declaration";
import { locateWorkspace } from "@intentius/chant/workspace/which-chant";
import type { BackendKey, BrokeredKey, SystemoneBackend } from "./config";

/** The path every Jev-compatible server serves. */
export const SYSTEMONE_PATH = "/v1/systemone";

/** How long a call may take before the backend counts as unreachable, when the backend names no `timeoutMs`. */
export const DEFAULT_TIMEOUT_MS = 30_000;

/** The request body. */
export interface SystemoneRequest {
  model: string;
  state: unknown;
  questions: Record<string, { type: string; instructions: string; criteria: Record<string, string> | string[] }>;
}

/** The response body, as far as this client reads it. */
export interface SystemoneResponse {
  model: string;
  answers: Record<string, WireAnswer>;
  usage?: { input_tokens?: number; output_tokens?: number };
}

/**
 * The name a point's question is sent under: the point's own name, so a
 * response reads back the way `points ask --response` reads one, with the
 * answer under `answers["<point>"]`.
 */
export const questionName = (point: string): string => point;

/** A backend or key that is configured wrongly: the activity refuses before asking anything. */
export class SystemoneConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SystemoneConfigError";
  }
}

/** Where a brokered capability is declared: the member and its broker. */
export interface BrokeredCapability {
  member: string;
  broker: string;
  scope: string[];
}

/**
 * The declaration's entry for a brokered key (#2726): the box member that
 * declares the capability, and the broker it names. Read from the workspace
 * declaration nearest above `cwd`, the same declaration `workspace status`
 * reads it from. Throws a {@link SystemoneConfigError} when no member declares
 * the capability, when more than one does and the key names none, or when the
 * capability names no broker.
 */
export function brokeredCapability(key: BrokeredKey, cwd: string): BrokeredCapability {
  let members;
  try {
    members = readDeclaration(locateWorkspace(cwd).tree).members;
  } catch (err) {
    throw new SystemoneConfigError(`the key names the brokered capability ${key.capability}, and the workspace declaration can't be read: ${err instanceof Error ? err.message : String(err)}`);
  }
  const declaring = members.filter((m) => (key.member === undefined || m.name === key.member) && m.box?.capabilities.some((c) => c.name === key.capability));
  if (declaring.length === 0) {
    const what = key.member !== undefined ? `member ${key.member}'s box does not declare the capability ${key.capability}` : `no member's box declares the capability ${key.capability}`;
    throw new SystemoneConfigError(`${what} (box.capabilities in chant.workspace.json, #2726)`);
  }
  if (declaring.length > 1) {
    throw new SystemoneConfigError(`the capability ${key.capability} is declared by ${declaring.map((m) => m.name).join(" and ")}: name the member in the key`);
  }
  const member = declaring[0];
  const capability = member.box!.capabilities.find((c) => c.name === key.capability)!;
  if (capability.broker === null) {
    throw new SystemoneConfigError(`member ${member.name}'s capability ${key.capability} names no broker (WSP122), so nothing holds its key`);
  }
  return { member: member.name, broker: capability.broker, scope: capability.scope };
}

/** Check a key reference without reading any secret: a string is a literal and refused, and a brokered capability must be declared. */
export function checkKey(key: unknown, where: string, cwd: string): void {
  if (key === undefined) return;
  if (typeof key === "string") {
    throw new SystemoneConfigError(`${where} is a literal string; a key is { env: "<VARIABLE>" } or a brokered capability, never the key itself (SYS001)`);
  }
  if (key !== null && typeof key === "object" && "capability" in key) brokeredCapability(key as BrokeredKey, cwd);
}

/**
 * The bearer key for one call, or undefined when none is sent: a backend with
 * no key, or a brokered capability whose broker is the endpoint. Throws when a
 * variable the key names is unset, which the chain reads as unreachable.
 */
export function resolveKey(key: BackendKey | undefined, cwd: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (key === undefined) return undefined;
  if ("capability" in key) {
    const brokered = brokeredCapability(key, cwd);
    if (key.env === undefined) return undefined;
    const value = env[key.env];
    if (!value) throw new Error(`the broker ${brokered.broker} has not set ${key.env} for the capability ${key.capability}`);
    return value;
  }
  const value = env[key.env];
  if (!value) throw new Error(`the environment variable ${key.env} is not set`);
  return value;
}

export interface SystemoneAskOptions {
  /** Backend name, as a point's model decider names it, to the backend. */
  backends: Record<string, SystemoneBackend>;
  /** Where the workspace declaration is found, for a brokered key. */
  cwd: string;
  /** The HTTP call. Defaults to the global fetch; a test passes its own. */
  transport?: typeof fetch;
  /** Defaults to process.env. */
  env?: NodeJS.ProcessEnv;
  /** Cancels an in-flight call, such as the Op's timeout. */
  signal?: AbortSignal;
  /** Called with each response, for usage and logs. */
  onResponse?: (backend: string, response: SystemoneResponse) => void;
}

function short(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > 300 ? `${flat.slice(0, 300)}...` : flat;
}

/** Post one question to one backend and return the model that answered and its answer. */
export async function postQuestion(backend: SystemoneBackend, name: string, request: ModelRequest, opts: Omit<SystemoneAskOptions, "backends">): Promise<{ model: string; answer: WireAnswer; response: SystemoneResponse }> {
  const key = resolveKey(backend.key, opts.cwd, opts.env);
  const question = questionName(request.point);
  const body: SystemoneRequest = {
    model: request.model,
    state: request.state,
    questions: { [question]: { type: request.question.type, instructions: request.question.instructions, criteria: request.question.criteria } },
  };
  const url = `${backend.url.replace(/\/+$/, "")}${SYSTEMONE_PATH}`;
  const timeout = AbortSignal.timeout(backend.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const signal = opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout;
  let res: Response;
  try {
    res = await (opts.transport ?? fetch)(url, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json", ...(key ? { authorization: `Bearer ${key}` } : {}) },
      body: JSON.stringify(body),
      signal,
    });
  } catch (err) {
    const why = timeout.aborted ? `no answer within ${backend.timeoutMs ?? DEFAULT_TIMEOUT_MS} ms` : err instanceof Error ? err.message : String(err);
    throw new Error(`${name} at ${url}: ${why}`);
  }
  const text = await res.text();
  if (!res.ok) throw new Error(`${name} at ${url} answered ${res.status}${text ? `: ${short(text)}` : ""}`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`${name} at ${url} answered with something that is not JSON: ${short(text)}`);
  }
  const r = parsed as Partial<SystemoneResponse> | null;
  if (r === null || typeof r !== "object") throw new Error(`${name} answered with no JSON object`);
  if (typeof r.model !== "string" || r.model === "") throw new Error(`${name}'s response names no model`);
  const answer = r.answers?.[question];
  if (answer === null || typeof answer !== "object") throw new Error(`${name}'s response has no answer to ${question}`);
  return { model: r.model, answer, response: r as SystemoneResponse };
}

/**
 * The model call for `askPoint`: each request goes to the backend its decider
 * names. A name no backend has throws, and so does anything
 * {@link postQuestion} throws, which the chain reads as unreachable.
 */
export function systemoneAsk(opts: SystemoneAskOptions): ModelAsk {
  return async (request) => {
    const backend = opts.backends[request.backend];
    if (!backend) throw new Error(`no backend named ${request.backend} is configured (systemone.backends)`);
    const { model, answer, response } = await postQuestion(backend, request.backend, request, opts);
    opts.onResponse?.(request.backend, response);
    return { model, answer };
  };
}
