/**
 * The first engine adapter (#2359): a {@link BehaviourTransport} that dials a
 * URL with a bearer token, and maps what the wire says onto the contract's
 * refusals.
 *
 * Unnamed on purpose. Nothing here is a vendor's API; it is the shape any
 * metered HTTP engine has — an address, an account, a request body, and four
 * ways the account or the wire can say no — so a second engine behind the
 * same shape is a second address and a second token, not a second adapter.
 * What this file knows about the engine is that it accepts a JSON body by
 * `POST`, answers with a JSON body, and uses the HTTP status the way HTTP
 * says to: `402` for an account with nothing left on it, `429` for a limit
 * that is spent, `401`/`403` for a token it does not accept.
 *
 * ## The token is on the wire and nowhere else
 *
 * Rule 3 of the contract — the engine is never handed a credential — is about
 * the request body, and `screenBehaviourRequest` has already walked the body
 * by the time a transport exists. The bearer token here is a different thing:
 * it is how the engine knows whose account to bill, it travels in the
 * `authorization` header, and this module is the only code that holds its
 * value. Four things follow, and each has a test:
 *
 *   - it is resolved from {@link behaviourTokenFrom}'s chain, never from the
 *     address chain, so no message that prints the address can print it;
 *   - it is never interpolated into a refusal, a `detail`, or an error — the
 *     variable's *name* is what a refusal carries;
 *   - whatever the engine writes back is passed through {@link concealing}
 *     before it becomes a `detail`, because an engine that echoes its request
 *     headers into an error page would otherwise put the token in a
 *     merge-request comment (#2358 posts refusals publicly);
 *   - the request is sent with `redirect: "error"`, so a `3xx` from the
 *     address named is a refusal rather than a second request carrying the
 *     header to whatever host the redirect names.
 *
 * ## No token, nothing sent
 *
 * This adapter is for an engine that bills an account: `engine-out-of-credit`
 * and `engine-over-quota` are statements about an account, and an engine
 * with no account has neither. So a token is required, and a missing one is
 * refused before anything is sent — {@link noBehaviourTokenRefusal}, naming
 * the chain — rather than sent bare and reported as whatever the engine's
 * 401 page said. An engine that needs no token is not this adapter's, and
 * the address chain still reaches it through a command on `PATH`.
 *
 * ## What the wire says, and what it becomes
 *
 * | Wire | Cause | Why |
 * |---|---|---|
 * | `2xx` | — | the body is the answer; the lexicon validates it |
 * | `401`, `403` | `no-engine` | the token was rejected; the remedy is to set the variable |
 * | `402` | `engine-out-of-credit` | the address answered; the account is empty |
 * | `429` | `engine-over-quota` | the address answered; a limit is spent; `retry-after` is echoed |
 * | any other status | `engine-unreachable` | the engine did not answer the question — a `5xx`, a `404`, a `3xx` |
 * | `fetch` threw | `engine-unreachable` | connection refused, no such host, TLS, or the timeout |
 *
 * `4xx` outside the three named is deliberately `engine-unreachable` rather
 * than a fifth cause. The contract's four causes are four remedies, and "the
 * engine rejected this request as malformed" has no remedy an operator can
 * apply — it is a bug on one side of the wire or the other, and the detail
 * names the status so whoever reads it can tell which side.
 */

import {
  behaviourTokenFrom,
  behaviourWireRefusal,
  noBehaviourTokenRefusal,
  rejectedBehaviourTokenRefusal,
  type BehaviourEngineEndpoint,
  type BehaviourEngineToken,
  type BehaviourRefusalReport,
  type BehaviourTransport,
  type BehaviourTransportOutcome,
} from "./behaviour";
import { REDACTED } from "./identity";

/** What {@link httpBehaviourTransport} can be handed instead of the process's own. */
export interface HttpBehaviourTransportDeps {
  /** The `fetch` to send with. Defaults to the global, and a test hands in a fake. */
  fetch?: typeof fetch;
  /** How long the engine has before it is treated as unreachable. */
  timeoutMs?: number;
}

/** The default deadline: the same one the command transport gives a child. */
export const HTTP_BEHAVIOUR_TIMEOUT_MS = 30_000;

/** How much of an error body a `detail` repeats. `scrubEngineDetail` bounds it again downstream. */
const MAX_BODY_IN_DETAIL = 300;

/** True when an address is one this adapter dials. `grpc://` and friends are not. */
export function isHttpBehaviourAddress(value: string): boolean {
  return /^https?:\/\//i.test(value.trim());
}

/**
 * Every occurrence of the token's value replaced, in text that came from the
 * engine or from an error. Exported so a test can assert on the one function
 * every `detail` passes through.
 *
 * `split`/`join` rather than a `RegExp`, so a token containing `.` or `+` is
 * matched as itself. Nothing shorter than four characters is concealed: a
 * one-letter "token" would blank every occurrence of that letter, which is a
 * detail nobody can read and a false sense that something was protected.
 */
export function concealing(token: BehaviourEngineToken, text: string): string {
  if (token.value.length < 4 || !text.includes(token.value)) return text;
  return text.split(token.value).join(REDACTED);
}

/**
 * The refusal an HTTP status earns, or `undefined` for a status that carries
 * an answer. Pure and exported so the whole table in the module doc is one
 * function a test can walk.
 *
 * `detail` is the first non-empty line of the response body, already
 * concealed; this adds the status in front of it so a `detail` never reads as
 * the engine's prose alone.
 */
export function httpStatusRefusal(
  lexicon: string,
  endpoint: BehaviourEngineEndpoint,
  token: BehaviourEngineToken,
  status: number,
  detail: string,
  retryAfter?: string,
): BehaviourRefusalReport | undefined {
  if (status >= 200 && status < 300) return undefined;
  const said = detail.trim().length > 0 ? `: ${detail.trim()}` : "";
  if (status === 401 || status === 403) {
    return rejectedBehaviourTokenRefusal(lexicon, endpoint, token, `HTTP ${status}${said}`);
  }
  if (status === 402) {
    // The account is the token's, so the variable that named the token is
    // the one an operator funds — put it first, ahead of whatever the
    // engine said, so `scrubEngineDetail`'s bound never drops it.
    return behaviourWireRefusal(
      lexicon,
      endpoint,
      "engine-out-of-credit",
      `the account ${token.source} authenticates answered HTTP 402${said}`,
    );
  }
  if (status === 429) {
    const window = retryAfter && retryAfter.trim().length > 0 ? `, retry after ${retryAfter.trim()}` : "";
    return behaviourWireRefusal(
      lexicon,
      endpoint,
      "engine-over-quota",
      `the account ${token.source} authenticates answered HTTP 429${window}${said}`,
    );
  }
  return behaviourWireRefusal(
    lexicon,
    endpoint,
    "engine-unreachable",
    `HTTP ${status}${said || " with no body"}`,
  );
}

/** The first non-empty line of a body, bounded, for a `detail`. */
function firstLine(text: string): string {
  const line = text.split("\n").find((l) => l.trim().length > 0)?.trim() ?? "";
  return line.length > MAX_BODY_IN_DETAIL ? `${line.slice(0, MAX_BODY_IN_DETAIL)}…` : line;
}

/**
 * Build the transport for one lexicon against one URL.
 *
 * The token is resolved here, once, from `env` — never from `process.env`
 * unless that is what was passed — so a test can drive the whole wire with an
 * environment of its own. A missing token makes a transport whose every
 * `send` refuses by name and sends nothing; see the module doc for why that is
 * the honest shape for an adapter whose engine bills an account.
 */
export function httpBehaviourTransport(
  lexicon: string,
  endpoint: BehaviourEngineEndpoint,
  env: Record<string, string | undefined>,
  deps: HttpBehaviourTransportDeps = {},
): BehaviourTransport {
  const token = behaviourTokenFrom(lexicon, env);
  const send = deps.fetch ?? globalThis.fetch;
  const timeoutMs = deps.timeoutMs ?? HTTP_BEHAVIOUR_TIMEOUT_MS;

  if (!token) {
    const refusal = noBehaviourTokenRefusal(lexicon, endpoint);
    return { async send(): Promise<BehaviourTransportOutcome> { return { ok: false, refusal }; } };
  }

  return {
    async send(body: string): Promise<BehaviourTransportOutcome> {
      let response: Response;
      try {
        response = await send(endpoint.value.trim(), {
          method: "POST",
          headers: {
            "content-type": "application/json",
            accept: "application/json",
            authorization: `Bearer ${token.value}`,
          },
          body,
          // A redirect would carry the header above to whatever host the
          // engine named. Refused here, reported as unreachable below.
          redirect: "error",
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (err) {
        return {
          ok: false,
          refusal: behaviourWireRefusal(
            lexicon,
            endpoint,
            "engine-unreachable",
            concealing(token, describeFetchError(err, timeoutMs)),
          ),
        };
      }

      const text = await response.text().catch(() => "");
      const refusal = httpStatusRefusal(
        lexicon,
        endpoint,
        token,
        response.status,
        concealing(token, firstLine(text)),
        response.headers.get("retry-after") ?? undefined,
      );
      if (refusal) return { ok: false, refusal };
      return { ok: true, body: concealing(token, text) };
    },
  };
}

/**
 * A thrown `fetch` in words an operator can act on. Node's `fetch` wraps the
 * socket error one level down (`err.cause.code`), and the timeout arrives as
 * a `TimeoutError` DOMException; both are named here rather than left as
 * `fetch failed`, which says nothing about which of the two it was.
 */
function describeFetchError(err: unknown, timeoutMs: number): string {
  if (err instanceof Error) {
    if (err.name === "TimeoutError" || err.name === "AbortError") {
      return `no answer within ${timeoutMs} ms`;
    }
    const cause = (err as { cause?: { code?: unknown; message?: unknown } }).cause;
    const code = typeof cause?.code === "string" ? cause.code : undefined;
    if (code) return `${code}: ${err.message}`;
    return err.message;
  }
  return String(err);
}
