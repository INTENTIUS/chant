/**
 * fountainRun — start a conversation from a declared Agent and follow it
 * to the end of its turn.
 *
 * Conversations are runs, not declarables (the one fountain kind the
 * lexicon deliberately does not model as a resource). This op is the
 * imperative half: resolve the agent by name, POST the conversation, and
 * poll until the turn is done.
 *
 * What "done" means depends on the agent's `sandbox_mode` (#2718). An
 * `ephemeral` conversation's machine is its own and this polls the
 * conversation's own status to `completed | failed | timed_out |
 * terminated` — none of which a running server's conversation status
 * actually reaches on its own, so in practice this waits out `timeoutMs`
 * and terminates, as it always has. A `persistent` agent's conversation
 * (`Steward`, and `Box` from #2705) shares one machine across every
 * conversation on it, and a turn ending there does not tear the sandbox
 * down: the conversation settles on `idle`, not on any of the four
 * statuses above. Waiting for one of those on a persistent agent is the
 * bug this op used to have — it waited out the whole deadline after the
 * turn had already finished, then terminated a machine that was meant to
 * persist. For `idle`, this instead reads the finished turn back
 * (`GET .../turns`) and returns its own outcome (`completed | failed |
 * interrupted` — fountain's `end_turn` block, or an error) without
 * terminating anything.
 *
 * Terminating the conversation's machine on deadline (a hung run should
 * not outlive the op that started it) still happens whenever the turn has
 * not ended — for either sandbox mode. `terminate` makes the choice
 * explicit rather than leaving it implicit in `sandbox_mode`.
 *
 * Under `chant run` the executor calls this as `fountainRun(args, signal)`
 * (#2775). When the signal fires (the step's timeout, or Ctrl-C) polling
 * stops, the terminate policy is applied as it is on the deadline, and the
 * step fails with the abort's reason.
 */

import {
  abortable,
  resolveConnection,
  defaultFountainHttp,
  type FountainHttp,
  type FountainConnectionDeps,
} from "./fountain-apply";

/**
 * Conversation statuses that end an *ephemeral* agent's run. `completed`
 * and `timed_out` are not values fountain's `Conversation.status` takes
 * today (its enum is `pending | running | idle | failed | terminated`) —
 * they are kept so a server that starts reporting them is handled without
 * a further change here.
 */
export const TERMINAL_STATUSES = new Set(["completed", "failed", "timed_out", "terminated"]);

/**
 * Conversation statuses that end a *persistent* agent's run: everything
 * {@link TERMINAL_STATUSES} does, plus `idle` — the status a persistent
 * conversation settles on once its turn ends, machine still up (#2718).
 */
export const PERSISTENT_DONE_STATUSES = new Set([...TERMINAL_STATUSES, "idle"]);

/** Turn statuses that mean the turn has ended — fountain's `end_turn` block, or an error. */
const TERMINAL_TURN_STATUSES = new Set(["completed", "failed", "interrupted"]);

/**
 * How `fountainRun` treats the conversation's machine once its wait ends
 * (#2718).
 *
 * - `on-deadline` — terminate only when `timeoutMs` is hit with the turn
 *   still unfinished, never on a turn that ended cleanly. This was
 *   `fountainRun`'s only behavior before this option existed.
 * - `never` — never terminate, even past the deadline; the caller, or
 *   fountain's own idle/max-lifetime bounds, is responsible for the machine.
 * - `always` — terminate whenever the wait ends, whether the turn ended
 *   cleanly or the deadline fired.
 */
export type TerminatePolicy = "never" | "on-deadline" | "always";

export interface FountainRunArgs {
  /** Agent name (resolved against /api/agents) or a raw agent id. */
  agent: string;
  prompt?: string;
  /** Optional vault to attach (subject to the agent's allowlist upstream). */
  vaultId?: string;
  endpoint?: string;
  token?: string;
  /**
   * Named `fountain.profiles` entry to resolve endpoint/token from (#2124).
   * Falls back to `defaultProfile` when omitted; ignored for any field an
   * explicit `endpoint`/`token` arg already supplies.
   */
  profile?: string;
  /** Project root `chant.config.ts` is read from. Default: process.cwd(). */
  cwd?: string;
  /** Give up after this long. Default 10 min. */
  timeoutMs?: number;
  /** Poll interval. Default 5s. */
  pollMs?: number;
  /**
   * When to terminate the conversation's machine (#2718). Default follows
   * the agent's `sandbox_mode`: `on-deadline` for `ephemeral` (unchanged),
   * `never` for `persistent` — its machine is a home meant to outlive the
   * conversation, so a run that hits its deadline leaves it be unless this
   * says otherwise.
   */
  terminate?: TerminatePolicy;
  /** Injectable clock/sleep for tests. */
  sleep?: (ms: number) => Promise<void>;
}

export interface FountainRunResult {
  conversationId: string;
  /**
   * The run's outcome. For a persistent agent whose turn ended, this is the
   * turn's own status (`completed | failed | interrupted`); otherwise it is
   * the conversation's status when the wait ended (`terminated` on a
   * deadline).
   */
  status: string;
  /** True when the agent's `sandbox_mode` resolved to `persistent`. */
  persistent: boolean;
  /** True when the op hit its deadline with the turn still unfinished. */
  terminatedByDeadline: boolean;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface ResolvedAgent {
  id: string;
  /** `ephemeral` or `persistent`; fountain's own default is `ephemeral`. */
  sandboxMode: string;
}

/** Resolve an agent by name or id, along with its `sandbox_mode`. */
export async function resolveAgent(http: FountainHttp, agent: string): Promise<ResolvedAgent> {
  if (UUID_RE.test(agent)) {
    const { status, json } = await http("GET", `/api/agents/${agent}`);
    if (status !== 200) throw new Error(`fountainRun: agent lookup failed (${status})`);
    const data = (json as { data?: { id?: string; sandbox_mode?: string } })?.data;
    if (!data?.id) throw new Error(`fountainRun: no agent "${agent}"`);
    return { id: data.id, sandboxMode: data.sandbox_mode ?? "ephemeral" };
  }
  const { status, json } = await http("GET", `/api/agents?search=${encodeURIComponent(agent)}`);
  if (status !== 200) throw new Error(`fountainRun: agent lookup failed (${status})`);
  const data =
    (json as { data?: Array<{ id: string; name: string; sandbox_mode?: string }> })?.data ?? [];
  const exact = data.find((a) => a.name === agent);
  if (!exact) throw new Error(`fountainRun: no agent named "${agent}"`);
  return { id: exact.id, sandboxMode: exact.sandbox_mode ?? "ephemeral" };
}

/** Agent id only — the common case, and the one call sites outside this file use. */
export async function resolveAgentId(http: FountainHttp, agent: string): Promise<string> {
  if (UUID_RE.test(agent)) return agent;
  return (await resolveAgent(http, agent)).id;
}

/** The latest turn's status, or undefined if it can't be read or none exists. */
async function latestTurnStatus(
  http: FountainHttp,
  conversationId: string,
): Promise<string | undefined> {
  const { status, json } = await http("GET", `/api/conversations/${conversationId}/turns`);
  if (status !== 200) return undefined;
  const turns = (json as { data?: Array<{ turn_number?: number; status?: string }> })?.data ?? [];
  if (turns.length === 0) return undefined;
  const latest = turns.reduce((a, b) => ((b.turn_number ?? 0) > (a.turn_number ?? 0) ? b : a));
  return latest.status;
}

export async function fountainRun(
  args: FountainRunArgs,
  signal?: AbortSignal,
  http?: FountainHttp,
  deps?: FountainConnectionDeps,
): Promise<FountainRunResult> {
  // `raw` is what the terminate call goes through: it must still reach
  // fountain after the signal has fired, so it does not carry the signal.
  let raw = http;
  let client = http;
  if (!raw) {
    const { endpoint, token } = await resolveConnection(args, deps);
    raw = defaultFountainHttp(endpoint, token);
    client = defaultFountainHttp(endpoint, token, signal);
  }
  client = abortable(client!, signal);
  const sleep = abortableSleep(args.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms))), signal);
  const timeoutMs = args.timeoutMs ?? 600_000;
  const pollMs = args.pollMs ?? 5_000;

  const { id: agentId, sandboxMode } = await resolveAgent(client, args.agent);
  const persistent = sandboxMode === "persistent";
  const terminatePolicy: TerminatePolicy = args.terminate ?? (persistent ? "never" : "on-deadline");
  const doneStatuses = persistent ? PERSISTENT_DONE_STATUSES : TERMINAL_STATUSES;

  const createBody: Record<string, unknown> = { agent_id: agentId };
  if (args.prompt !== undefined) createBody.prompt = args.prompt;
  if (args.vaultId !== undefined) createBody.vault_id = args.vaultId;

  const created = await client("POST", "/api/conversations", createBody);
  if (created.status !== 201 && created.status !== 200) {
    throw new Error(`fountainRun: conversation create failed (${created.status})`);
  }
  const conversationId = (created.json as { data?: { id?: string } })?.data?.id;
  if (!conversationId) throw new Error("fountainRun: conversation create returned no id");

  const deadline = Date.now() + timeoutMs;
  let conversationStatus = "pending";
  try {
    while (Date.now() < deadline) {
      const res = await client("GET", `/api/conversations/${conversationId}`);
      if (res.status === 200) {
        conversationStatus =
          (res.json as { data?: { status?: string } })?.data?.status ?? conversationStatus;
        if (doneStatuses.has(conversationStatus)) {
          let status = conversationStatus;
          if (persistent && conversationStatus === "idle") {
            const turnStatus = await latestTurnStatus(client, conversationId);
            if (turnStatus && TERMINAL_TURN_STATUSES.has(turnStatus)) status = turnStatus;
          }
          if (terminatePolicy === "always") {
            await client("POST", `/api/conversations/${conversationId}/terminate`);
          }
          return { conversationId, status, persistent, terminatedByDeadline: false };
        }
      }
      await sleep(pollMs);
    }
  } catch (err) {
    // Aborted mid-wait: the turn has not ended, so the policy decides as it
    // does on the deadline. Anything else propagates untouched.
    if (signal?.aborted && terminatePolicy !== "never") {
      await raw("POST", `/api/conversations/${conversationId}/terminate`).catch(() => {});
    }
    throw err;
  }

  // Deadline: the turn never ended (or, for an ephemeral conversation, its
  // done-status is never observed on the wire — see TERMINAL_STATUSES).
  // `never` leaves a hung run's machine alone; every other policy ends the
  // conversation so it does not outlive the op.
  if (terminatePolicy !== "never") {
    await client("POST", `/api/conversations/${conversationId}/terminate`);
  }
  return { conversationId, status: "terminated", persistent, terminatedByDeadline: true };
}

/** `sleep`, cut short by `signal`: rejects with the signal's reason as soon as it fires. */
function abortableSleep(
  sleep: (ms: number) => Promise<void>,
  signal?: AbortSignal,
): (ms: number) => Promise<void> {
  if (!signal) return sleep;
  return (ms) => {
    signal.throwIfAborted();
    return new Promise<void>((resolve, reject) => {
      const onAbort = () => reject(signal.reason);
      signal.addEventListener("abort", onAbort, { once: true });
      sleep(ms).then(
        () => {
          signal.removeEventListener("abort", onAbort);
          resolve();
        },
        (err) => {
          signal.removeEventListener("abort", onAbort);
          reject(err);
        },
      );
    });
  };
}
