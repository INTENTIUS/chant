/**
 * The seam between this lexicon and whatever answers its request (#2357),
 * on the contract's transport (#2373, decided in #2359).
 *
 * `packages/core/src/behaviour.ts` says what a prediction may mean, how an
 * absent engine must refuse, and — since #2359 — how a request reaches an
 * engine: a `BehaviourTransport` carries the rendered request and brings back
 * the engine's text or a finished refusal. This file adds what is augur's on
 * top of that and nothing more: the parse of an `augur/v1` answer, a command
 * transport for an address that is a program on `PATH`, and the chooser that
 * turns an address into one transport or the other.
 *
 * {@link BehaviourEngine} is what `./predict-behaviour.ts` talks to. It is
 * one level above the transport — request in, parsed answer or refusal out —
 * so the fixture engine in `__fixtures__` can be one without pretending to be
 * a wire, and so `predict-behaviour.ts` never sees a byte. {@link
 * transportEngine} is the only bridge between the two levels.
 *
 * ## The two transports
 *
 * A **URL** is dialled by core's `httpBehaviourTransport`
 * (`packages/core/src/behaviour-http.ts`): `POST`, a bearer token from
 * `CHANT_BEHAVIOUR_TOKEN_AUGUR` → `CHANT_BEHAVIOUR_TOKEN` → `BEHAVIOUR_TOKEN`,
 * and the status mapping the contract fixes. Nothing about that is augur's,
 * which is why it does not live here.
 *
 * A **command on PATH** is {@link commandTransport}, below: request on stdin,
 * answer on stdout, no shell — a shell would make the address a
 * code-execution surface for whatever set the variable. The child gets
 * `behaviourEngineChildEnvironment()` and nothing else, for the reason given
 * on that function: the request-side screen cannot see an inherited
 * `process.env`. An engine that answered and still refused says so on stderr,
 * and the words it uses pick the cause.
 *
 * ## A malformed answer is unreachable, not a report with holes
 *
 * Taking the fields that parsed and reporting the rest unpredicted would turn
 * an engine emitting garbage into an estate that looks partly free — the
 * failure the refusal arm exists to prevent, one level down. So the parse
 * refuses whole, with a detail naming the entity and the field.
 *
 * With one exception, and it is the same rule the command transport applies
 * to stderr: an engine that took the request, answered `200`, and wrote
 * `{"error": "out of credit"}` has refused for a reason a status never
 * carried. {@link transportEngine} reads that body's words after the parse
 * has failed and never before, so an answer that priced the estate and
 * declined one node "rate limit reached for this region" stays the report it
 * is. Both transports reach the same three causes; only the evidence differs.
 */

import { execFile, type ExecFileException } from "node:child_process";
import {
  behaviourEngineChildEnvironment,
  behaviourWireRefusal,
  isBehaviourBasis,
  isResilienceVerdict,
  unreachableBehaviourEngineRefusal,
} from "@intentius/chant/behaviour";
import type {
  BehaviourBasis,
  BehaviourEngineEndpoint,
  BehaviourRefusalReport,
  BehaviourTransport,
  BehaviourWireCause,
  ResilienceVerdict,
} from "@intentius/chant/behaviour";
import { httpBehaviourTransport, isHttpBehaviourAddress } from "@intentius/chant/behaviour-http";
import type { HttpBehaviourTransportDeps } from "@intentius/chant/behaviour-http";
import type { EngineRequest } from "./request";
import { renderEngineRequest } from "./request";

/** The name this lexicon refuses under, and the one that scopes its variables. */
export const AUGUR = "augur";

/** One entity's figures, as the engine states them. */
export interface EngineFigure {
  perHour: number;
  currency: string;
  headroom: { cpu?: number; latency?: number };
  errorRate: number;
  resilience: { failure: string; verdict: ResilienceVerdict; note?: string };
  rightSize?: { suggestion: string; reason?: string };
}

/** A run the engine answered. */
export interface EngineAnswer {
  /** How the engine names itself, its version, and the tolerance it states. */
  engine: string;
  version: string;
  tolerance: string;
  basis: BehaviourBasis;
  /** An estate total, when the engine states one of its own. Never chant's sum. */
  total?: { perHour: number; currency: string };
  /** Figures, keyed by the node name the request used. */
  figures: Record<string, EngineFigure>;
  /**
   * Nodes the engine was sent and declined, keyed by name, with its reason.
   * Separate from an absent key: a node in neither map is a defect, and
   * `./predict-behaviour.ts` reports it rather than dropping it.
   */
  declined?: Record<string, string>;
}

/**
 * What an engine call comes back with: a parsed answer, or a refusal built
 * by whoever saw the failure — the transport for a wire condition, this file
 * for an answer that does not parse. `./predict-behaviour.ts` returns the
 * refusal as it stands and never rebuilds one, which is how the contract's
 * four causes stay four remedies rather than one lexicon's guess.
 */
export type EngineOutcome = { ok: true; answer: EngineAnswer } | { ok: false; refusal: BehaviourRefusalReport };

/** Whatever answers a request, one level above the wire. The fixture engine is one of these. */
export interface BehaviourEngine {
  predict(request: EngineRequest): Promise<EngineOutcome>;
}

/**
 * Resolve an address to an engine, or to `undefined` when nothing here
 * speaks it. `env` is where a transport that authenticates reads its token
 * from, and a chooser that has no use for it may ignore it. A caller that
 * gets `undefined` refuses as `engine-unreachable` naming the address, which
 * is the honest verdict for an address chant cannot dial.
 */
export type EngineConnect = (
  endpoint: BehaviourEngineEndpoint,
  env: Record<string, string | undefined>,
) => BehaviourEngine | undefined;

/**
 * A {@link BehaviourEngine} over a contract transport: render the request
 * canonically, send it, parse what came back. The one bridge between the
 * transport level and the engine level, so the parse runs on every wire and
 * no transport gets its own.
 */
export function transportEngine(
  transport: BehaviourTransport,
  endpoint: BehaviourEngineEndpoint,
): BehaviourEngine {
  return {
    async predict(request: EngineRequest): Promise<EngineOutcome> {
      const sent = await transport.send(renderEngineRequest(request));
      if (!sent.ok) return { ok: false, refusal: sent.refusal };
      const parsed = parseEngineAnswer(sent.body);
      if (!parsed.ok) {
        // An engine that answers 200 with an error envelope is a real shape,
        // and its own words are the only thing that says which refusal it is.
        // Read after the parse and never before: an answer that priced the
        // estate and declined one node "rate limit reached for this region"
        // parses, and a vocabulary check running first would turn a report
        // about the other nodes into an over-quota refusal about none.
        const said = causeFromEngineWords(sent.body);
        if (said) {
          return {
            ok: false,
            refusal: behaviourWireRefusal(AUGUR, endpoint, said, `the engine answered ${firstLine(sent.body)}`),
          };
        }
        return { ok: false, refusal: unreachableBehaviourEngineRefusal(AUGUR, endpoint, parsed.detail) };
      }
      return { ok: true, answer: parsed.answer };
    },
  };
}

/** How long a command engine is given before it is treated as unreachable. */
const COMMAND_TIMEOUT_MS = 30_000;

/** How much stdout is read before the answer is treated as malformed. */
const COMMAND_MAX_BUFFER = 8 * 1024 * 1024;

/**
 * A `command on PATH` address, run as a subprocess: the contract's
 * `BehaviourTransport` for the third kind of address it names.
 *
 * The address is split on whitespace into a program and its arguments, which
 * is the shape `CHANT_BEHAVIOUR_ENGINE="augur-engine --model tiny"` produces.
 * No shell: a shell would make the address a code-execution surface for
 * whatever set the variable, and every argument the address needs can be
 * written without one.
 */
export function commandTransport(endpoint: BehaviourEngineEndpoint): BehaviourTransport {
  const [program, ...args] = endpoint.value.trim().split(/\s+/);
  return {
    async send(body: string) {
      const raw = await new Promise<{ stdout: string; error?: ExecFileException; stderr: string }>(
        (resolve) => {
          const child = execFile(
            program,
            args,
            {
              timeout: COMMAND_TIMEOUT_MS,
              maxBuffer: COMMAND_MAX_BUFFER,
              // Not `process.env`. The contract's rule, and its reason, are on
              // `behaviourEngineChildEnvironment`; the test below pins it.
              env: behaviourEngineChildEnvironment(),
            },
            (error, stdout, stderr) => {
              resolve({ stdout: String(stdout), stderr: String(stderr), ...(error ? { error } : {}) });
            },
          );
          child.stdin?.end(body);
        },
      );

      if (raw.error) {
        return {
          ok: false,
          refusal: behaviourWireRefusal(
            AUGUR,
            endpoint,
            causeFromEngineWords(raw.stderr) ?? "engine-unreachable",
            firstLine(raw.stderr) || raw.error.message,
          ),
        };
      }
      return { ok: true, body: raw.stdout };
    },
  };
}

/** {@link commandTransport}, bridged to the engine level. */
export function commandEngine(endpoint: BehaviourEngineEndpoint): BehaviourEngine {
  return transportEngine(commandTransport(endpoint), endpoint);
}

/**
 * An engine that answered and still refused says so in words, and the three
 * causes want three different actions (`behaviour.ts`'s remedy table). Matched
 * on the words an engine would use rather than on an exit code or an HTTP
 * status, because the contract fixes no exit codes, inventing some would bind
 * every future engine to this file, and a status is only available on one of
 * the two transports anyway.
 *
 * Both transports read it, on the text each has: a command's stderr, and an
 * HTTP body that failed to parse as an answer. `./behaviour-http.ts` has
 * already classified every status that carries one, so this runs on the case
 * a status does not cover — the engine that took the request, answered 200,
 * and put its refusal in the envelope.
 */
function causeFromEngineWords(said: string): BehaviourWireCause | undefined {
  const text = said.toLowerCase();
  if (/\b(out of credit|insufficient (funds|balance)|no balance|payment required)\b/.test(text)) {
    return "engine-out-of-credit";
  }
  if (/\b(over quota|quota exceeded|rate limit|too many requests|throttl)/.test(text)) {
    return "engine-over-quota";
  }
  return undefined;
}

function firstLine(text: string): string {
  return text.split("\n").find((line) => line.trim().length > 0)?.trim() ?? "";
}

/**
 * Everything wrong with one figure, as readable field paths. Empty means the
 * figure is usable.
 *
 * Pure and exported so the shapes an engine can get wrong are testable without
 * a subprocess. Every check here mirrors one `validateBehaviourBlock` applies
 * downstream (`packages/core/src/behaviour.ts`) — the difference is *when*:
 * that one throws, and a throw is the whole-lexicon failure `lexicon.ts`
 * reserves for a live credential. A third party emitting one bad number is not
 * that, and reporting it as that is how an operator goes looking for a leak.
 */
export function figureProblems(name: string, figure: unknown): string[] {
  const at = (field: string) => `figures.${name}.${field}`;
  if (typeof figure !== "object" || figure === null || Array.isArray(figure)) {
    return [`${at("")} is ${Array.isArray(figure) ? "an array" : typeof figure}, not an object`];
  }
  const f = figure as Record<string, unknown>;
  const out: string[] = [];

  const fraction = (field: string, value: unknown) => {
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
      out.push(`${at(field)} is not a number in 0..1`);
    }
  };

  if (typeof f.perHour !== "number" || !Number.isFinite(f.perHour) || f.perHour < 0) {
    out.push(`${at("perHour")} is not a non-negative finite number`);
  }
  if (typeof f.currency !== "string" || f.currency.trim().length === 0) {
    out.push(`${at("currency")} is empty`);
  }
  fraction("errorRate", f.errorRate);

  const headroom = f.headroom;
  if (typeof headroom !== "object" || headroom === null || Array.isArray(headroom)) {
    out.push(`${at("headroom")} is missing`);
  } else {
    const h = headroom as Record<string, unknown>;
    // At least one axis, and an axis the engine did not model must be absent
    // rather than zero — zero headroom means saturated, the opposite claim.
    if (h.cpu === undefined && h.latency === undefined) {
      out.push(`${at("headroom")} carries neither cpu nor latency`);
    }
    for (const axis of ["cpu", "latency"] as const) {
      if (h[axis] !== undefined) fraction(`headroom.${axis}`, h[axis]);
    }
  }

  const resilience = f.resilience;
  if (typeof resilience !== "object" || resilience === null || Array.isArray(resilience)) {
    out.push(`${at("resilience")} is missing`);
  } else {
    const r = resilience as Record<string, unknown>;
    if (typeof r.failure !== "string" || r.failure.trim().length === 0) {
      out.push(`${at("resilience.failure")} names no failure`);
    }
    if (!isResilienceVerdict(r.verdict)) {
      out.push(`${at("resilience.verdict")} is not survives/degrades/fails`);
    }
    if (r.note !== undefined && typeof r.note !== "string") {
      out.push(`${at("resilience.note")} is not a string`);
    }
  }

  const rightSize = f.rightSize;
  if (rightSize !== undefined) {
    if (typeof rightSize !== "object" || rightSize === null || Array.isArray(rightSize)) {
      out.push(`${at("rightSize")} is not an object`);
    } else if (typeof (rightSize as Record<string, unknown>).suggestion !== "string") {
      out.push(`${at("rightSize.suggestion")} is missing`);
    }
  }

  return out;
}

/**
 * What the parse of an engine's text comes to: the answer, or a detail
 * naming what was wrong with it. Not a refusal yet — {@link transportEngine}
 * builds that, with the endpoint the parse does not need to know.
 */
export type ParsedEngineAnswer = { ok: true; answer: EngineAnswer } | { ok: false; detail: string };

/** One malformed verdict, with the detail the refusal will scrub and print. */
function malformed(detail: string): ParsedEngineAnswer {
  return { ok: false, detail };
}

/**
 * Parse an engine's text into an {@link EngineAnswer}.
 *
 * A malformed answer is `engine-unreachable` and not a report full of holes.
 * The alternative — taking the fields that parsed and reporting the rest as
 * unpredicted — would turn an engine emitting garbage into an estate that
 * looks partially free, which is the failure the refusal arm exists to
 * prevent, one level down.
 *
 * **Every figure is validated here, not only the envelope.** The first version
 * of this function checked `engine`/`version`/`tolerance`/`basis` and that
 * `figures` was an object, and then handed each figure's contents straight to
 * `block()` in `./predict-behaviour.ts`, which dereferenced
 * `figure.resilience.failure`. Seven malformed shapes were executed against
 * it and all seven threw: three as bare `TypeError`s with no chant message,
 * four through `validateBehaviourBlock` after the fact. A throw is the
 * whole-lexicon failure `lexicon.ts` reserves for a live credential in the
 * request, so a third-party engine emitting one bad number was indistinguishable
 * from a leak — and the doc above claimed the opposite was happening.
 *
 * The detail names the entity and the field, because "the engine sent
 * something wrong" is not a thing anybody can act on and "figures.web.headroom
 * carries neither cpu nor latency" is. It flows into
 * `unreachableBehaviourEngineRefusal`, which runs it through
 * `scrubEngineDetail` and bounds it.
 */
export function parseEngineAnswer(text: string): ParsedEngineAnswer {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return malformed(`the engine wrote ${text.length} byte(s) that are not JSON`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return malformed("the engine's answer is not an object");
  }
  const answer = parsed as Partial<EngineAnswer>;

  const missing = (["engine", "version", "tolerance"] as const).filter(
    (key) => typeof answer[key] !== "string" || (answer[key] as string).trim().length === 0,
  );
  if (missing.length > 0) {
    return malformed(
      `the engine's answer states no ${missing.join(", ")}. Every figure carries provenance, so an ` +
        "answer that cannot say who produced it is not a usable answer",
    );
  }
  // A closed enum downstream, so a free-form basis is caught here rather than
  // by a throw from `validateBehaviourBlock` after the report is half built.
  if (!isBehaviourBasis(answer.basis)) {
    return malformed(
      `the engine's answer states a basis of ${JSON.stringify(answer.basis)}, which is not ` +
        "modeled or validated",
    );
  }

  if (typeof answer.figures !== "object" || answer.figures === null || Array.isArray(answer.figures)) {
    // `Array.isArray` explicitly: `typeof [] === "object"`, so `figures: []`
    // parsed clean and produced a report in which every node had been lost.
    return malformed("the engine's answer carries no figures map");
  }

  if (answer.total !== undefined) {
    const total = answer.total as Record<string, unknown>;
    if (
      typeof total !== "object" ||
      total === null ||
      typeof total.perHour !== "number" ||
      !Number.isFinite(total.perHour) ||
      total.perHour < 0 ||
      typeof total.currency !== "string" ||
      total.currency.trim().length === 0
    ) {
      return malformed("the engine's answer states a total that is not a non-negative rate in a named currency");
    }
  }

  if (answer.declined !== undefined) {
    const declined = answer.declined as unknown;
    if (typeof declined !== "object" || declined === null || Array.isArray(declined)) {
      return malformed("the engine's answer carries a declined list that is not a map");
    }
    for (const [name, reason] of Object.entries(declined as Record<string, unknown>)) {
      if (typeof reason !== "string") {
        return malformed(`the engine declined ${name} with a reason that is not a string`);
      }
    }
  }

  const problems: string[] = [];
  for (const [name, figure] of Object.entries(answer.figures as Record<string, unknown>)) {
    problems.push(...figureProblems(name, figure));
    if (problems.length >= 5) break;
  }
  if (problems.length > 0) {
    return malformed(
      `the engine's answer is malformed: ${problems.slice(0, 5).join("; ")}` +
        (problems.length >= 5 ? " (and possibly more)" : ""),
    );
  }

  return { ok: true, answer: answer as EngineAnswer };
}

/**
 * The transport chooser, with what the HTTP transport needs injectable.
 *
 * A `http://` or `https://` address gets core's `httpBehaviourTransport`,
 * with its token read from `env` — the same `env` the address was read from,
 * so a test drives both chains from one object. A bare address gets
 * {@link commandTransport}. Any other scheme (`grpc://`, `unix://`) gets
 * `undefined`, and the caller refuses naming the address: no transport here
 * speaks it, and saying so beats a guess.
 */
export function connectWith(deps: HttpBehaviourTransportDeps = {}): EngineConnect {
  return (endpoint, env) => {
    const address = endpoint.value.trim();
    if (address.length === 0) return undefined;
    if (isHttpBehaviourAddress(address)) {
      return transportEngine(httpBehaviourTransport(AUGUR, endpoint, env, deps), endpoint);
    }
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(address)) return undefined;
    return commandEngine(endpoint);
  };
}

/** The chooser the shipped plugin uses: the process's own `fetch`, the default deadline. */
export const defaultConnect: EngineConnect = connectWith();
