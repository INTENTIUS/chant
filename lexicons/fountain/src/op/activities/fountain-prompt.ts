/**
 * fountainPrompt: add a turn to a conversation that already exists, and
 * follow that turn to its end (#3356).
 *
 * `fountainRun` starts a conversation and waits out its first turn. This is
 * the next turn on the same conversation: fountain's
 * `POST /api/conversations/{id}/prompts`, which queues a turn on the same
 * runtime session (fountain wakes the conversation, provisioning a fresh
 * machine that resumes the session, when its server has gone). The turn is
 * found by the `client_request_id` this sends with the prompt, and polled on
 * `GET .../turns` until it is `completed`, `failed` or `interrupted`.
 *
 * What fountain v0.21.0 can and cannot do here, which decides the arguments:
 *
 * - A conversation that is `terminated` takes no more turns: the prompts route
 *   answers 410. `fountainRun` terminates an ephemeral agent's conversation at
 *   its deadline by default, so a caller that wants a later turn runs the first
 *   one with `terminate: "never"` (a persistent agent's default) and ends the
 *   conversation itself, or with this op's `terminate`, after the last turn.
 * - A turn has no tool allowlist of its own. The prompts route takes only the
 *   prompt, images and `client_request_id`; the tools a conversation may use are
 *   its agent's `permission_policy`, narrowed once at launch, and nothing on the
 *   API narrows them for one turn. So this op takes no `tools`: the narrowing
 *   has to be on the agent, or on the launch.
 * - A turn has no cap on its agent loop. The cap here is time: past `timeoutMs`
 *   the turn is interrupted (`POST .../interrupt`), which ends the turn and
 *   leaves the conversation up.
 *
 * Under `chant run` the executor calls this as `fountainPrompt(args, signal)`.
 * When the signal fires, polling stops, the turn is interrupted, the
 * `terminate` policy is applied as at the deadline, and the step fails with
 * the abort's reason.
 */

import { randomUUID } from "node:crypto";
import {
  abortable,
  resolveConnection,
  defaultFountainHttp,
  type FountainHttp,
  type FountainConnectionDeps,
} from "./fountain-apply";
import type { TerminatePolicy } from "./fountain-run";

/** Turn statuses that mean the turn has ended: fountain's `end_turn`, an error, or an interrupt. */
const ENDED_TURN_STATUSES = new Set(["completed", "failed", "interrupted"]);

export interface FountainPromptArgs {
  /** The conversation's id, as `fountainRun` returns it in `conversationId`. */
  conversation: string;
  /** The turn's prompt. Must carry words. */
  prompt: string;
  /**
   * fountain's `client_request_id`: the name the turn is found by. Defaults
   * to `chant-<uuid>`. Make it unique within the conversation; fountain does
   * not deduplicate on it.
   */
  clientRequestId?: string;
  endpoint?: string;
  token?: string;
  /** Named `fountain.profiles` entry to resolve endpoint/token from, as for `fountainRun`. */
  profile?: string;
  /** Project root `chant.config.ts` is read from. Default: process.cwd(). */
  cwd?: string;
  /** The turn's cap: past this the turn is interrupted. Default 10 min. */
  timeoutMs?: number;
  /** Poll interval. Default 5s. */
  pollMs?: number;
  /**
   * What happens to the conversation when the wait ends: `never` (the
   * default) leaves it up for another turn, `on-deadline` terminates it only
   * when the turn had to be interrupted, `always` terminates it either way.
   */
  terminate?: TerminatePolicy;
  /** Injectable sleep for tests. */
  sleep?: (ms: number) => Promise<void>;
}

export interface FountainPromptResult {
  conversationId: string;
  /** The `client_request_id` the turn was sent and found by. */
  clientRequestId: string;
  /** The turn's id and number, once fountain listed the turn. */
  turnId?: string;
  turnNumber?: number;
  /** The turn's outcome: `completed`, `failed` or `interrupted`. */
  status: string;
  /** True when the turn ran past `timeoutMs` and was interrupted. */
  interruptedByDeadline: boolean;
  /** fountain's `limit_reason`: a service limit that ended the turn, which makes even a `completed` turn incomplete. */
  limitReason?: string;
  /** True when the conversation was terminated after the turn. */
  terminated: boolean;
}

interface TurnView {
  id?: string;
  turn_number?: number;
  status?: string;
  client_request_id?: string | null;
  limit_reason?: string | null;
}

/** The latest turn opened by `clientRequestId`, or undefined. */
async function turnOf(http: FountainHttp, conversationId: string, clientRequestId: string): Promise<TurnView | undefined> {
  const { status, json } = await http("GET", `/api/conversations/${conversationId}/turns`);
  if (status !== 200) return undefined;
  const turns = ((json as { data?: TurnView[] })?.data ?? []).filter((t) => t.client_request_id === clientRequestId);
  if (turns.length === 0) return undefined;
  return turns.reduce((a, b) => ((b.turn_number ?? 0) > (a.turn_number ?? 0) ? b : a));
}

function refusal(conversationId: string, status: number, json: unknown): Error {
  const detail = (json as { error?: unknown; errors?: unknown } | null)?.error ?? (json as { errors?: unknown } | null)?.errors;
  const why = detail === undefined ? "" : `: ${typeof detail === "string" ? detail : JSON.stringify(detail)}`;
  switch (status) {
    case 410:
      return new Error(
        `fountainPrompt: conversation ${conversationId} is terminated, and fountain adds no turn to a terminated conversation. ` +
          `Run the earlier turn with terminate: "never" and end the conversation after the last turn`,
      );
    case 400:
      return new Error(`fountainPrompt: conversation ${conversationId} is busy: a turn is running (400)${why}`);
    case 404:
      return new Error(`fountainPrompt: no conversation ${conversationId} (404)`);
    case 409:
      return new Error(`fountainPrompt: conversation ${conversationId}'s sandbox is being reset or deleted (409)${why}`);
    default:
      return new Error(`fountainPrompt: the prompt was refused (${status})${why}`);
  }
}

export async function fountainPrompt(
  args: FountainPromptArgs,
  signal?: AbortSignal,
  http?: FountainHttp,
  deps?: FountainConnectionDeps,
): Promise<FountainPromptResult> {
  if (typeof args?.conversation !== "string" || args.conversation === "") throw new Error("fountainPrompt: needs the conversation's id");
  if (typeof args.prompt !== "string" || args.prompt.trim() === "") throw new Error("fountainPrompt: needs a prompt with words in it");
  // `raw` reaches fountain after the signal has fired, for the interrupt and terminate.
  let raw = http;
  let client = http;
  if (!raw) {
    const { endpoint, token } = await resolveConnection(args, deps);
    raw = defaultFountainHttp(endpoint, token);
    client = defaultFountainHttp(endpoint, token, signal);
  }
  client = abortable(client!, signal);
  const sleep = args.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const timeoutMs = args.timeoutMs ?? 600_000;
  const pollMs = args.pollMs ?? 5_000;
  const policy: TerminatePolicy = args.terminate ?? "never";
  const conversationId = args.conversation;
  const clientRequestId = args.clientRequestId ?? `chant-${randomUUID()}`;

  const sent = await client("POST", `/api/conversations/${conversationId}/prompts`, { prompt: args.prompt, client_request_id: clientRequestId });
  if (sent.status !== 200 && sent.status !== 201 && sent.status !== 202) throw refusal(conversationId, sent.status, sent.json);

  let turn: TurnView | undefined;
  const done = async (status: string, interruptedByDeadline: boolean): Promise<FountainPromptResult> => {
    const terminate = policy === "always" || (policy === "on-deadline" && interruptedByDeadline);
    if (terminate) await raw!("POST", `/api/conversations/${conversationId}/terminate`);
    return {
      conversationId,
      clientRequestId,
      ...(turn?.id ? { turnId: turn.id } : {}),
      ...(turn?.turn_number !== undefined ? { turnNumber: turn.turn_number } : {}),
      status,
      interruptedByDeadline,
      ...(turn?.limit_reason ? { limitReason: turn.limit_reason } : {}),
      terminated: terminate,
    };
  };
  const interrupt = () => raw!("POST", `/api/conversations/${conversationId}/interrupt`).catch(() => undefined);

  const deadline = Date.now() + timeoutMs;
  try {
    while (Date.now() < deadline) {
      turn = (await turnOf(client, conversationId, clientRequestId)) ?? turn;
      if (turn?.status && ENDED_TURN_STATUSES.has(turn.status)) return await done(turn.status, false);
      signal?.throwIfAborted();
      await sleep(pollMs);
    }
  } catch (err) {
    if (signal?.aborted) {
      await interrupt();
      if (policy !== "never") await raw!("POST", `/api/conversations/${conversationId}/terminate`).catch(() => undefined);
    }
    throw err;
  }

  // The cap: the turn ran past timeoutMs. Interrupting ends the turn and keeps the conversation.
  await interrupt();
  turn = (await turnOf(raw!, conversationId, clientRequestId)) ?? turn;
  return done("interrupted", true);
}
