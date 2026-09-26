/**
 * A decision point asked inside an Op run (#2749), and in a steward's turn in
 * particular.
 *
 * An Op that needs a decision (the factory's builder tier, whether to ship)
 * calls {@link askPointInRun} from one of its activities, such as the decide
 * activity (#2740). It asks the point through `askPoint` (ws-058,
 * `../workspace/decide.ts`), which records the question and its answer as a
 * record, and then:
 *
 * - an `answered` question returns its answer, and the Op goes on;
 * - an `escalated` or `proposed` question is open, so the activity throws
 *   {@link PointWait}. The executor ends the run there with status `waiting`,
 *   as a gate ends it with `gated`: no later step runs, no `onFailure` phase
 *   runs, and the run ledger records the question the run is waiting on.
 *
 * The question stays open in the workspace, where `chant workspace points
 * --open`, MCP's `workspace-points` and hud read it, and a person answers it
 * with `points answer`. Nothing waits in the meantime: the next run asks the
 * same point with the same inputs, finds the answer record, and goes on. A
 * local steward re-runs a waiting Op on the first round after its question is
 * answered (`./operator.ts`).
 *
 * ## In a steward's turn
 *
 * A steward runs unattended, so two more rules hold when the process is a
 * steward's turn (`./steward-turn.ts`):
 *
 * - The model call goes through the broker. The caller supplies the call as a
 *   {@link BrokeredModelAsk}, which is handed the box capability to reach the
 *   model through, and only a capability the steward declares
 *   (`declareSteward({ capabilities })`, #2726). A steward that names none,
 *   or holds a vault, makes no model call: the model decider is recorded as
 *   not reached and the question goes to people.
 * - The question names the steward and its run in its source block, and
 *   neither the steward's turn nor the steward's name can answer it: `points
 *   answer` refuses inside a steward's turn (`answer-in-steward-turn`) and
 *   leaves the asking steward out of the quorum.
 *
 * The question never goes to the steward's own thread: on Fountain that thread
 * is the steward's, and nobody reads it for questions.
 */

import type { ModelAsk, ModelRequest, WireAnswer } from "../workspace/points";
import type { QuestionView } from "../workspace/decide";
import { currentStewardTurn, type StewardTurn } from "./steward-turn";

/** The box capability a model call goes through when the caller names none. */
export const DEFAULT_INFERENCE_CAPABILITY = "inference";

/** The open question a run stopped on, as the run ledger records it. */
export interface WaitingPoint {
  /** The answer record's id: what `points answer` and hud name. */
  id: string;
  /** The point asked. */
  point: string;
  /** Its state when the run stopped: `escalated` to people, or `proposed` by a model and waiting for a person to confirm it. */
  state: "escalated" | "proposed";
  /** The answer record, from the repository root. */
  path: string;
  /** What the question is about, or null. */
  subject: string | null;
  /** The steward whose turn asked it, or null. */
  steward: string | null;
}

/** The marker {@link PointWait} carries, so a copy of core linked twice still recognises it. */
const POINT_WAIT = Symbol.for("chant.op.PointWait");

/**
 * Thrown by an activity whose decision point is open. Not a failure: the
 * executor ends the run with status `waiting` (see the module doc).
 */
export class PointWait extends Error {
  readonly [POINT_WAIT] = true;
  constructor(readonly question: WaitingPoint) {
    super(
      `waiting on decision point ${question.point} (${question.id}, ${question.state}): ` +
        `a person answers it through hud or \`chant workspace points answer ${question.id}\``,
    );
    this.name = "PointWait";
  }
}

/** Is this a {@link PointWait}? Duck-typed on the shared symbol. */
export function isPointWait(err: unknown): err is PointWait {
  return !!err && typeof err === "object" && (err as Record<symbol, unknown>)[POINT_WAIT] === true && "question" in err;
}

/**
 * The model call, supplied by the caller (the decide activity, #2740, or a
 * test's stub), made through a box capability. `via.capability` is the
 * capability to reach the model through and `via.broker` the broker the
 * member's box block names for it, when that is known. The function holds no
 * credential: the broker does.
 */
export type BrokeredModelAsk = (
  request: ModelRequest,
  via: { capability: string; broker: string | null },
) => Promise<{ model: string; answer: WireAnswer }>;

export interface AskPointInRunOptions {
  /** Where the workspace and the answer kind are found. */
  cwd: string;
  point: string;
  inputs: unknown;
  subject?: string;
  /** The answer kind file, or a declared kind's name. */
  kind?: string;
  /** The model call. Without it, a model decider is not asked. */
  ask?: BrokeredModelAsk;
  /** The box capability the model call goes through. Default `inference`. */
  capability?: string;
  /** The broker the member's box block names for the capability, when the caller has read it. */
  broker?: string | null;
  /** The date written as asked_on, YYYY-MM-DD. */
  on?: string;
  /** The steward turn, when the caller has it. Default: this process's (`currentStewardTurn`). */
  turn?: StewardTurn | null;
}

/** What a steward reaches through its broker, read from its declaration when the turn named only the steward. */
async function stewardCapabilities(turn: StewardTurn, cwd: string): Promise<{ capabilities: readonly string[]; vault: string | null }> {
  if (turn.capabilities !== undefined) return { capabilities: turn.capabilities, vault: turn.vault ?? null };
  const { discoverStewards } = await import("./discover");
  const found = (await discoverStewards({ cwd })).stewards.get(turn.steward)?.declaration;
  return { capabilities: found?.capabilities ?? [], vault: found?.vault ?? null };
}

/**
 * The {@link ModelAsk} a point is asked with. In a steward's turn the call is
 * made only through a capability the steward declares; otherwise it throws,
 * which the chain records as the model not being reached.
 */
export async function brokeredModelAsk(
  ask: BrokeredModelAsk,
  opts: { capability?: string; broker?: string | null; turn?: StewardTurn | null; cwd: string },
): Promise<ModelAsk> {
  const capability = opts.capability ?? DEFAULT_INFERENCE_CAPABILITY;
  const via = { capability, broker: opts.broker ?? null };
  const turn = opts.turn === undefined ? currentStewardTurn() : opts.turn;
  if (!turn) return (request) => ask(request, via);
  const { capabilities, vault } = await stewardCapabilities(turn, opts.cwd);
  if (!capabilities.includes(capability)) {
    const why =
      vault !== null
        ? `the steward ${turn.steward} holds the vault ${vault} and names no brokered capabilities, and a steward's model call goes through the broker`
        : `the steward ${turn.steward} does not name the brokered capability ${capability}` +
          (capabilities.length ? ` (it names ${capabilities.join(", ")})` : "") +
          `, and a steward holds no credential of its own`;
    return async () => {
      throw new Error(why);
    };
  }
  return (request) => ask(request, via);
}

/**
 * Ask a decision point from inside an Op run. Resolves with the answer when
 * the question is answered, and throws {@link PointWait} when it is open.
 * Any other problem (the points can't be read, the inputs are wrong, a model
 * declared `unreachable: "fail"` could not answer) throws an ordinary error,
 * which fails the step.
 */
export async function askPointInRun(opts: AskPointInRunOptions): Promise<{ answer: string | boolean; question: QuestionView }> {
  const turn = opts.turn === undefined ? currentStewardTurn() : opts.turn;
  const ask = opts.ask ? await brokeredModelAsk(opts.ask, { capability: opts.capability, broker: opts.broker, turn, cwd: opts.cwd }) : undefined;
  const { askPoint } = await import("../workspace/decide");
  const doc = await askPoint({
    cwd: opts.cwd,
    point: opts.point,
    inputs: opts.inputs,
    ...(opts.subject !== undefined ? { subject: opts.subject } : {}),
    ...(opts.kind !== undefined ? { kind: opts.kind } : {}),
    ...(ask ? { ask } : {}),
    ...(opts.on !== undefined ? { on: opts.on } : {}),
    ...(turn ? { steward: { name: turn.steward, ...(turn.run ? { run: turn.run } : {}) } } : {}),
  });
  if ("error" in doc) throw new Error(`decision point ${opts.point}: ${doc.error.code}: ${doc.error.message}`);
  const q = doc.question;
  if (q.state === "answered" && q.answer !== null) return { answer: q.answer, question: q };
  throw new PointWait({
    id: q.id,
    point: q.point,
    state: q.state === "proposed" ? "proposed" : "escalated",
    path: q.path,
    subject: q.subject,
    steward: q.askedBy?.steward ?? null,
  });
}
