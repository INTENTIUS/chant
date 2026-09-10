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
 * Parse an engine's stdout into an {@link EngineAnswer}.
 *
 * A malformed answer is `engine-unreachable` and not a report full of holes.
 * The alternative — taking the fields that parsed and reporting the rest as
 * unpredicted — would turn an engine emitting garbage into an estate that
 * looks partially free, which is the failure the refusal arm exists to
 * prevent, one level down.
 */
export function parseEngineAnswer(stdout: string): EngineOutcome {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return {
      ok: false,
      failure: {
        cause: "engine-unreachable",
        detail: `the engine wrote ${stdout.length} byte(s) that are not JSON`,
      },
    };
  }
  if (typeof parsed !== "object" || parsed === null) {
    return { ok: false, failure: { cause: "engine-unreachable", detail: "the engine's answer is not an object" } };
  }
  const answer = parsed as Partial<EngineAnswer>;
  const missing = (["engine", "version", "tolerance", "basis"] as const).filter(
    (key) => typeof answer[key] !== "string" || (answer[key] as string).length === 0,
  );
  if (missing.length > 0) {
    return {
      ok: false,
      failure: {
        cause: "engine-unreachable",
        detail:
          `the engine's answer states no ${missing.join(", ")}. Every figure carries provenance, so ` +
          "an answer that cannot say who produced it is not a usable answer",
      },
    };
  }
  if (typeof answer.figures !== "object" || answer.figures === null) {
    return { ok: false, failure: { cause: "engine-unreachable", detail: "the engine's answer carries no figures map" } };
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
