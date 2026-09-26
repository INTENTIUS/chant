/**
 * A stub `POST /v1/systemone` server for tests: a real HTTP server on
 * 127.0.0.1 that checks a request the way a Jev-compatible server would and
 * answers with what the test scripts. No model runs.
 *
 * ```ts
 * const stub = await startStubBackend({ key: "k", answers: { slice_tier: { type: "choice", choice: "large", probabilities: {...}, confidence: 0.9 } } });
 * // backends: { systemone: { url: stub.url, key: { env: "STUB_KEY" } } }
 * await stub.close();
 * ```
 *
 * It answers 401 when a key is set and the request's bearer differs, 422 when
 * the body is not a request in the wire format, and `status` when the test
 * forces one (429 or 529, say). Every request it read is kept in `requests`.
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { WireAnswer } from "@intentius/chant/workspace/points";
import { SYSTEMONE_PATH, type SystemoneRequest } from "./backend";

export interface StubQuestion {
  name: string;
  type: string;
  instructions: string;
  criteria: Record<string, string> | string[];
}

export interface StubBackendOptions {
  /** The bearer key the stub requires. Without it, any request is taken. */
  key?: string;
  /** The model id the response reports. Defaults to the id the request sent. */
  model?: string;
  /** The answer to a question, by question name, or computed from the question. Defaults to {@link defaultAnswer}. */
  answers?: Record<string, WireAnswer> | ((question: StubQuestion, request: SystemoneRequest) => WireAnswer);
  /** Answer every request with this status and no answers. */
  status?: number;
}

export interface StubBackend {
  /** The base URL, without `/v1/systemone`. */
  url: string;
  /** Each request body the stub read, in order. */
  requests: SystemoneRequest[];
  /** The Authorization header of each request, or null. */
  authorizations: (string | null)[];
  close(): Promise<void>;
}

/** A confident answer of the question's own type: true, the first option, or the last level. */
export function defaultAnswer(question: StubQuestion): WireAnswer {
  if (question.type === "noul") return { type: "noul", noul: 0.95 };
  if (question.type === "choice") {
    const options = Object.keys(question.criteria);
    const rest = options.length > 1 ? 0.05 / (options.length - 1) : 0;
    const probabilities = Object.fromEntries(options.map((o, i) => [o, i === 0 ? 0.95 : rest]));
    return { type: "choice", choice: options[0], probabilities, confidence: 0.925 };
  }
  if (question.type === "score") {
    const levels = question.criteria as string[];
    const probabilities = Object.fromEntries(levels.map((l, i) => [l, i === levels.length - 1 ? 0.95 : 0.05 / Math.max(1, levels.length - 1)]));
    return { type: "score", score: levels.length - 0.05, probabilities, confidence: 0.925 };
  }
  return { type: "unsupported" };
}

/** Why a body is not a request in the wire format, or null when it is one. */
export function requestProblem(body: unknown): string | null {
  if (body === null || typeof body !== "object" || Array.isArray(body)) return "the body is not a JSON object";
  const b = body as Record<string, unknown>;
  if (typeof b.model !== "string" || b.model === "") return "model is required";
  if (b.state === undefined) return "state is required";
  if (b.questions === null || typeof b.questions !== "object" || Array.isArray(b.questions) || Object.keys(b.questions).length === 0) return "questions must name at least one question";
  for (const [name, q] of Object.entries(b.questions as Record<string, unknown>)) {
    const question = q as Record<string, unknown> | null;
    if (question === null || typeof question !== "object") return `questions.${name} is not an object`;
    if (typeof question.instructions !== "string") return `questions.${name}.instructions is required`;
    if (question.type === "noul" || question.type === "choice") {
      if (question.criteria === null || typeof question.criteria !== "object" || Array.isArray(question.criteria)) return `questions.${name}.criteria must be an object`;
      if (question.type === "noul" && !("true" in question.criteria && "false" in question.criteria)) return `questions.${name}.criteria must describe true and false`;
    } else if (question.type === "score") {
      if (!Array.isArray(question.criteria) || question.criteria.length < 2 || question.criteria.length > 10) return `questions.${name}.criteria must be 2 to 10 levels`;
    } else {
      return `questions.${name}.type must be noul, choice or score`;
    }
  }
  return null;
}

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf-8");
}

/** Start the stub on a free port on 127.0.0.1. */
export async function startStubBackend(opts: StubBackendOptions = {}): Promise<StubBackend> {
  const requests: SystemoneRequest[] = [];
  const authorizations: (string | null)[] = [];
  const server = createServer((req, res) => {
    void (async () => {
      if (req.method !== "POST" || req.url !== SYSTEMONE_PATH) return send(res, 404, { error: { type: "not_found", message: `${req.method} ${req.url}` } });
      const auth = req.headers.authorization ?? null;
      authorizations.push(auth);
      if (opts.key !== undefined && auth !== `Bearer ${opts.key}`) return send(res, 401, { error: { type: "authentication_error", message: "invalid key" } });
      let body: unknown;
      try {
        body = JSON.parse(await readBody(req));
      } catch {
        return send(res, 422, { error: { type: "invalid_request", message: "the body is not JSON" } });
      }
      const problem = requestProblem(body);
      if (problem) return send(res, 422, { error: { type: "invalid_request", message: problem } });
      const request = body as SystemoneRequest;
      requests.push(request);
      if (opts.status !== undefined) return send(res, opts.status, { error: { type: "stub", message: `the stub answers ${opts.status}` } });
      const answers: Record<string, WireAnswer> = {};
      for (const [name, q] of Object.entries(request.questions)) {
        const question: StubQuestion = { name, ...q };
        const scripted = typeof opts.answers === "function" ? opts.answers(question, request) : opts.answers?.[name];
        answers[name] = scripted ?? defaultAnswer(question);
      }
      send(res, 200, { model: opts.model ?? request.model, answers, usage: { input_tokens: JSON.stringify(request).length, output_tokens: 0 } });
    })().catch((err: unknown) => send(res, 500, { error: { type: "stub", message: err instanceof Error ? err.message : String(err) } }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    authorizations,
    close: () => new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve()))),
  };
}
