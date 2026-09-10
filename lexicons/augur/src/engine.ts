/**
 * The seam between this lexicon and whatever answers its request (#2357).
 *
 * `packages/core/src/behaviour.ts` says what a prediction may mean and how an
 * absent engine must refuse. It says nothing about how a request reaches an
 * engine, deliberately — the epic keeps the engine abstract, "held to a stated
 * shape and nothing more specific". So the transport is the lexicon's to
 * define, and this file defines exactly one thing: an object with a `predict`
 * method that takes {@link EngineRequest} and returns an answer or a named
 * failure.
 *
 * That narrowness is the point. #2359's first adapter is a `BehaviourEngine`
 * and so is the process transport below, and neither of them is a second code
 * path through the rest of this lexicon: `./predict-behaviour.ts` maps one
 * {@link EngineOutcome} onto the contract's four refusal builders and does not
 * know which transport produced it.
 *
 * ## The transport that ships here
 *
 * `behaviourEngineFrom` resolves an address that may be "a URL, a socket path,
 * or a command on PATH". {@link commandEngine} implements the third: the
 * request goes to the command's stdin as canonical JSON, the answer comes back
 * on stdout as JSON, a non-zero exit is a named failure. It is engine-neutral
 * — there is no vendor in it, no token, and no retry policy — which is why it
 * belongs with the request rather than with #2359's adapter, whose job is a
 * particular vendor's API, its token chain and its credit accounting.
 *
 * A URL address gets a named refusal rather than a fetch. That is #2359's, and
 * inventing an HTTP shape here would give that issue a shape to fight rather
 * than a seam to fill.
 *
 * ## The child's environment is not this process's
 *
 * Rule 3 of the epic is that the engine never sees credentials, and
 * `screenBehaviourRequest` enforces it on the request. A subprocess inheriting
 * `process.env` would walk straight around that check: the request would be
 * spotless and the child would hold `AWS_SECRET_ACCESS_KEY` anyway. So
 * {@link commandEngine} spawns with an explicitly built environment holding
 * `PATH` and nothing else. The engine is a third party; it gets the graph and
 * the traffic level.
 */

import { execFile, type ExecFileException } from "node:child_process";
import { isBehaviourBasis, isResilienceVerdict } from "@intentius/chant/behaviour";
import type { BehaviourBasis, BehaviourEngineEndpoint, ResilienceVerdict } from "@intentius/chant/behaviour";
import type { EngineRequest } from "./request";
import { renderEngineRequest } from "./request";

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
 * A run the engine did not answer, in the three shapes the contract
 * distinguishes. `no-engine` is not here: that is decided before a transport
 * is chosen at all.
 */
export interface EngineFailure {
  cause: "engine-unreachable" | "engine-out-of-credit" | "engine-over-quota";
  /** Free text for the refusal's detail. `scrubEngineDetail` bounds it downstream. */
  detail: string;
}

export type EngineOutcome = { ok: true; answer: EngineAnswer } | { ok: false; failure: EngineFailure };

/** Whatever answers a request. #2359's adapter is one of these. */
export interface BehaviourEngine {
  predict(request: EngineRequest): Promise<EngineOutcome>;
}

/**
 * Resolve an address to a transport, or to `undefined` when nothing here
 * speaks it. A caller that gets `undefined` refuses as `engine-unreachable`
 * naming the address, which is the honest verdict for an address chant cannot
 * dial.
 */
export type EngineConnect = (endpoint: BehaviourEngineEndpoint) => BehaviourEngine | undefined;

/** How long a command engine is given before it is treated as unreachable. */
const COMMAND_TIMEOUT_MS = 30_000;

/** How much stdout is read before the answer is treated as malformed. */
const COMMAND_MAX_BUFFER = 8 * 1024 * 1024;

/**
 * A `command on PATH` address, run as a subprocess.
 *
 * The address is split on whitespace into a program and its arguments, which
 * is the shape `CHANT_BEHAVIOUR_ENGINE="augur-engine --model tiny"` produces.
 * No shell: a shell would make the address a code-execution surface for
 * whatever set the variable, and every argument the address needs can be
 * written without one.
 */
export function commandEngine(command: string): BehaviourEngine {
  const [program, ...args] = command.trim().split(/\s+/);
  return {
    async predict(request: EngineRequest): Promise<EngineOutcome> {
      const body = renderEngineRequest(request);
      const raw = await new Promise<{ stdout: string; error?: ExecFileException; stderr: string }>(
        (resolve) => {
          const child = execFile(
            program,
            args,
            {
              timeout: COMMAND_TIMEOUT_MS,
              maxBuffer: COMMAND_MAX_BUFFER,
              // Not `process.env`. See the module doc: an inherited environment
              // is a credential channel the request-side screen cannot see.
              env: { PATH: process.env.PATH ?? "" },
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
          failure: {
            cause: causeFromStderr(raw.stderr) ?? "engine-unreachable",
            detail: firstLine(raw.stderr) || raw.error.message,
          },
        };
      }
      return parseEngineAnswer(raw.stdout);
    },
  };
}

/**
 * An engine that answered and still refused says so on stderr, and the three
 * causes want three different actions (`behaviour.ts`'s remedy table). Matched
 * on the words an engine would use rather than on an exit code, because the
 * contract fixes no exit codes and inventing some would bind every future
 * engine to this file.
 */
function causeFromStderr(stderr: string): EngineFailure["cause"] | undefined {
  const text = stderr.toLowerCase();
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

/** One `engine-unreachable` outcome, with the detail the refusal will scrub and print. */
function malformed(detail: string): EngineOutcome {
  return { ok: false, failure: { cause: "engine-unreachable", detail } };
}

/**
 * Parse an engine's stdout into an {@link EngineAnswer}.
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
export function parseEngineAnswer(stdout: string): EngineOutcome {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return malformed(`the engine wrote ${stdout.length} byte(s) that are not JSON`);
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
 * The transport chooser this lexicon ships.
 *
 * A command address gets {@link commandEngine}. A URL gets `undefined`, and
 * the caller turns that into a refusal naming the address — the HTTP shape is
 * #2359's to define, and guessing at one here would hand that issue a
 * decision already made badly rather than an open seam.
 */
export const defaultConnect: EngineConnect = (endpoint) => {
  const address = endpoint.value.trim();
  if (address.length === 0) return undefined;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(address)) return undefined;
  return commandEngine(address);
};
