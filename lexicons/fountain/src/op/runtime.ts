/**
 * The fountain `opRuntime` provider (#2126, epic #2115).
 *
 * `chant run <op> --on fountain` hands the run to a fountain teammate instead
 * of executing it here. This module is the client for that: it posts the
 * command line `chant run <op>` as a prompt on the steward's thread, tails the
 * conversation's SSE stream, and reports what comes back through the
 * {@link OpRuntimeProvider} contract core defines in
 * `packages/core/src/op/runtime.ts`.
 *
 * It holds no state of its own. Run records land on chant's ledger from
 * *inside* the sandbox — the executor running there writes them — so `status`,
 * `log` and `list` here read fountain's turns rather than a ledger this
 * process keeps. What a turn's final message carries is the same
 * {@link OpRunRecord} the local runtime would have written, so a hosted run
 * reads back in the shape every other reader already knows.
 *
 * Two seams, both injectable so a test drives the whole path with no network:
 * {@link FountainHttp} (the one `fountain-apply.ts` already defines, reused
 * verbatim) for REST, and {@link FountainSse} beside it for the event stream.
 * A test scripts a stream, including a connection that ends without a terminal
 * event, and watches the reader resume from `Last-Event-ID`.
 *
 * ## Finding the steward
 *
 * The steward is resolved in this order:
 *
 * 1. a declared `Steward` (#2127) that lists this Op. The composite registers
 *    the mapping when the project's declarations load, so this answers
 *    whenever the run and the declaration share a process.
 * 2. the profile's `team` (#2124) — a teammate name. The post goes to
 *    `POST /api/team/:agent_id/messages`, which serialises against the turn in
 *    flight. That refusal is fountain's single-writer rule, and it is the
 *    reason a steward thread is the right place for an op to run.
 * 3. `--param agent=<name>`, then the Op's `labels.Agent`. Either opens a
 *    fresh conversation with `POST /api/conversations` instead.
 *
 * A `400 conversation_busy` is reported with the conversation's address and
 * never retried: the steward is running another op, and queueing behind it
 * from a CLI that may be Ctrl-C'd in a second would be a promise this client
 * cannot keep.
 *
 * ## Patience
 *
 * Fountain closes an idle SSE connection after 60 seconds, so a turn that
 * thinks for a while and prints nothing loses its connection. That is not the
 * end of the turn. The reader reconnects with `Last-Event-ID`, which replays
 * what arrived while it had none. Only genuine silence ends the wait, after
 * `FOUNTAIN_STREAM_IDLE_TIMEOUT` seconds (default 1800), and it ends it with
 * an error that names the conversation rather than reporting success.
 *
 * Patience is not the answer when the conversation itself has died, though
 * (#2167). A sandbox that fails to provision leaves the conversation `failed`
 * with `turn_count: 0` and no `stage: turn` event will ever arrive, so waiting
 * half an hour reports nothing anyone can act on. Whenever the stream goes
 * quiet — every {@link DEFAULT_CONVERSATION_POLL_MS} of silence, and again
 * whenever a connection ends — `GET /api/conversations/:id` is read, and a
 * terminal status there settles the run with fountain's own reason. `status`
 * reads the same thing: a conversation that failed before its first turn is a
 * failed run, not "no run is recorded".
 */

import { loadChantConfig, type ChantConfig } from "@intentius/chant/config";
import type { OpConfig, OpRunHandle, OpRunRecord, OpRunStartOptions, OpRunState, OpRunStatus, OpRuntimeProvider, StepRecord } from "@intentius/chant/op";
import { runStateOf } from "@intentius/chant/op";
import type { GateResolutionRecord } from "@intentius/chant/lifecycle/gate-ledger";
import { resolveProfile, type FountainProfile } from "../config";
import {
  defaultFountainHttp,
  resolveConnection,
  type FountainHttp,
} from "./activities/fountain-apply";
import { resolveAgentId } from "./activities/fountain-run";
import { stewardForOp } from "../composites/steward";
import { runPrompt } from "./run-prompt";

export { runPrompt };

// ── The SSE seam ──────────────────────────────────────────────────────────

/** One server-sent event, already framed. `data` is the raw payload text. */
export interface FountainSseEvent {
  /** The event id, which becomes the next connection's `Last-Event-ID`. */
  id?: string;
  /** The SSE `event:` field, when the server named one. */
  event?: string;
  data: string;
}

/**
 * Open one SSE connection. The iterable ends when the connection does —
 * including fountain's 60-second idle close, which is not the end of the turn.
 * The caller reconnects; this seam never does.
 */
export interface FountainSse {
  (path: string, opts?: { lastEventId?: string; signal?: AbortSignal }): AsyncIterable<FountainSseEvent>;
}

/** The production SSE reader: `fetch`, then the wire format, and nothing else. */
export function defaultFountainSse(endpoint: string, token: string): FountainSse {
  return (path, opts) => ({
    async *[Symbol.asyncIterator]() {
      const res = await fetch(`${endpoint}${path}`, {
        headers: {
          authorization: `Bearer ${token}`,
          accept: "text/event-stream",
          ...(opts?.lastEventId ? { "last-event-id": opts.lastEventId } : {}),
        },
        ...(opts?.signal ? { signal: opts.signal } : {}),
      });
      if (!res.ok || !res.body) {
        throw new Error(`fountain runtime: stream ${path} failed (${res.status})`);
      }
      const decoder = new TextDecoder();
      let buffer = "";
      // Node's ReadableStream is async-iterable at runtime; the DOM lib type
      // this compiles against does not say so, so read it as one explicitly
      // rather than suppressing the error and hoping the lib never changes.
      const body = res.body as unknown as AsyncIterable<Uint8Array>;
      for await (const chunk of body) {
        buffer += decoder.decode(chunk, { stream: true });
        let split = buffer.indexOf("\n\n");
        while (split !== -1) {
          const frame = buffer.slice(0, split);
          buffer = buffer.slice(split + 2);
          const event = parseSseFrame(frame);
          if (event) yield event;
          split = buffer.indexOf("\n\n");
        }
      }
      const last = parseSseFrame(buffer);
      if (last) yield last;
    },
  });
}

/**
 * One `id:`/`event:`/`data:` block into an event. Several `data:` lines join
 * with a newline, which is what the spec says and what a multi-line JSON
 * payload needs. Returns `undefined` for a frame that carries no data — a
 * comment heartbeat, or the blank tail of the buffer.
 */
export function parseSseFrame(frame: string): FountainSseEvent | undefined {
  const data: string[] = [];
  let id: string | undefined;
  let event: string | undefined;
  for (const line of frame.split("\n")) {
    if (line.startsWith(":") || line.trim() === "") continue;
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    const value = colon === -1 ? "" : line.slice(colon + 1).replace(/^ /, "");
    if (field === "data") data.push(value);
    else if (field === "id") id = value;
    else if (field === "event") event = value;
  }
  if (data.length === 0) return undefined;
  return { ...(id ? { id } : {}), ...(event ? { event } : {}), data: data.join("\n") };
}

// ── Wire shapes ───────────────────────────────────────────────────────────

/**
 * A conversation log event, as the stream and the history endpoint both carry
 * it. Every field is optional: this client reads the few it needs and leaves
 * the rest of fountain's payload alone rather than restating a schema it does
 * not own.
 */
interface LogEvent {
  id?: string;
  conversation_id?: string;
  turn_id?: string;
  stream?: string;
  stage?: string;
  state?: string;
  blocks?: Block[];
}

/** One parsed block (`?blocks=true`), in whichever dialect the runtime speaks. */
interface Block {
  kind?: string;
  /** `tool_call` / `tool_call_update` identity, so an update finds its call. */
  id?: string;
  tool_call_id?: string;
  name?: string;
  title?: string;
  status?: string;
  body?: string;
  text?: string;
}

interface Turn {
  id?: string;
  prompt?: string;
  state?: string;
  status?: string;
  created_at?: string;
  started_at?: string;
  ended_at?: string;
  completed_at?: string;
}

interface Conversation {
  id?: string;
  status?: string;
  channel_id?: string;
  /** Turns run on this conversation. `0` means no turn ever started. */
  turn_count?: number;
  /** The machine behind it, whose own status is usually why a run died. */
  sandbox?: { status?: string } | null;
  inserted_at?: string;
  updated_at?: string;
  last_active_at?: string;
}

// ── Options ───────────────────────────────────────────────────────────────

export interface FountainOpRuntimeOptions {
  /** Explicit endpoint; otherwise the profile's, then `FOUNTAIN_ENDPOINT`. */
  endpoint?: string;
  /** Explicit token; otherwise the profile's env var, then `FOUNTAIN_TOKEN`. */
  token?: string;
  /**
   * Named `fountain.profiles` entry (#2124). Falls back to `defaultProfile`.
   * This is the provider's default; `start` overrides it per run from
   * `OpRunStartOptions.profile`, which is what `--profile` carries (#2192).
   */
  profile?: string;
  /** Project root `chant.config.ts` is read from. Default: `process.cwd()`. */
  cwd?: string;
  /** Pre-loaded project config, so a test skips the disk read. */
  config?: ChantConfig;
  /** REST seam. Injected by tests; otherwise `defaultFountainHttp`. */
  http?: FountainHttp;
  /** Stream seam. Injected by tests; otherwise `defaultFountainSse`. */
  sse?: FountainSse;
  /**
   * How long total silence is tolerated before the wait is called off, in
   * milliseconds. Default: `FOUNTAIN_STREAM_IDLE_TIMEOUT` seconds, or 30
   * minutes — the same patience the fountain CLI has.
   */
  idleTimeoutMs?: number;
  /**
   * How much stream silence asks fountain what became of the conversation
   * (#2167), in milliseconds. Default {@link DEFAULT_CONVERSATION_POLL_MS}.
   */
  conversationPollMs?: number;
  /** Injectable clock, so a test can age the stream without waiting. */
  now?: () => number;
  /**
   * Answer the conversation's pending permission request instead of posting
   * the approve prompt (`--durable-requests`). Stubbed: the request answer
   * endpoint this needs is BinaryBourbon/fountain#1635, which has not shipped,
   * so the flag currently refuses with that issue's number rather than
   * pretending to have resolved anything.
   *
   * Omitted, it is read off the invocation — `--durable-requests` on the
   * command line, or `FOUNTAIN_DURABLE_REQUESTS=1`. A provider is a plain
   * value on `LexiconPlugin.opRuntime`, constructed before any argument is
   * parsed, so a per-invocation flag has nowhere else to arrive from until the
   * contract carries one.
   */
  durableRequests?: boolean;
}

/** Silence this long ends the wait. Widened with `FOUNTAIN_STREAM_IDLE_TIMEOUT`, in seconds. */
export const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 1_800_000;

/**
 * Silence this long asks fountain what became of the conversation (#2167).
 *
 * Two seconds is short enough that a conversation that died during provision
 * is reported about as fast as fountain knew it, and long enough that a turn
 * thinking quietly for half an hour costs a handful of cheap reads a minute
 * rather than one per second.
 */
export const DEFAULT_CONVERSATION_POLL_MS = 2_000;

/** Conversation statuses no turn will ever start from. */
const TERMINAL_CONVERSATION_STATUSES = new Set(["failed", "terminated"]);

/** Has fountain given up on this conversation? Pure. */
export function conversationIsTerminal(status?: string): boolean {
  return status !== undefined && TERMINAL_CONVERSATION_STATUSES.has(status);
}

/**
 * Fountain's own account of a conversation that ended without running the
 * turn — its status, its sandbox's, and how many turns it managed. Pure.
 */
export function conversationFailureReason(conversation: Conversation): string {
  const sandbox = conversation.sandbox?.status;
  const turns = conversation.turn_count ?? 0;
  return (
    `fountain ended conversation ${conversation.id ?? "?"} as "${conversation.status ?? "unknown"}"` +
    (sandbox ? ` with its sandbox "${sandbox}"` : "") +
    (turns === 0 ? ", before the turn started" : `, after ${turns} turn(s)`)
  );
}

/** A reconnect that yields nothing is normal; a fake that always does is not. */
const MAX_RECONNECTS = 1000;

// ── Pure helpers ──────────────────────────────────────────────────────────

/** Does this turn's prompt name `op`? The prompt is `chant run <op>`, exactly. */
export function turnRunsOp(turn: Turn, op: string): boolean {
  const prompt = (turn.prompt ?? "").trim();
  return prompt === runPrompt(op) || prompt.startsWith(`${runPrompt(op)} `);
}

/**
 * The run record a turn's final message carries.
 *
 * The executor inside the sandbox prints its ledger record as JSON, so the
 * last balanced JSON object in the turn's text is the run's outcome. A fenced
 * block is unwrapped first — an agent that narrates around its output is the
 * ordinary case, not an error.
 */
export function parseRunRecord(text: string): OpRunRecord | undefined {
  for (const candidate of jsonCandidates(text)) {
    try {
      const value = JSON.parse(candidate) as Partial<OpRunRecord>;
      if (value && typeof value === "object" && typeof value.op === "string" && typeof value.status === "string") {
        return value as OpRunRecord;
      }
    } catch {
      // Not JSON, or not this one. Try the next candidate.
    }
  }
  return undefined;
}

/** Every balanced `{...}` span in `text`, last first — the final one is the answer. */
function jsonCandidates(text: string): string[] {
  const fenced = [...text.matchAll(/```(?:json)?\s*([\s\S]*?)```/g)].map((m) => m[1].trim());
  const spans: string[] = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") {
      if (depth === 0) start = i;
      depth++;
    } else if (ch === "}") {
      depth--;
      if (depth === 0 && start !== -1) spans.push(text.slice(start, i + 1));
      if (depth < 0) depth = 0;
    }
  }
  return [...fenced.reverse(), ...spans.reverse()];
}

/**
 * Fountain's own vocabulary onto {@link OpRunState}. A conversation is
 * `running | idle | failed | terminated`; a turn is `started | done | failed |
 * interrupted`. The turn wins when it has settled, because the conversation
 * outlives the run it hosted.
 */
export function runStateOfTurn(conversationStatus?: string, turnState?: string): OpRunState {
  switch (turnState) {
    case "done":
    case "completed":
      return "completed";
    case "failed":
      return "failed";
    case "interrupted":
    case "cancelled":
      return "cancelled";
    case "started":
    case "running":
      return "running";
    default:
      break;
  }
  switch (conversationStatus) {
    case "running":
      return "running";
    case "failed":
      return "failed";
    case "terminated":
      return "cancelled";
    default:
      return "completed";
  }
}

/** A turn with no parsable record, reported from what the turn itself says. */
function statusFromTurn(op: string, conversation: Conversation, turn: Turn): OpRunStatus {
  const started = turn.started_at ?? turn.created_at ?? new Date(0).toISOString();
  const ended = turn.ended_at ?? turn.completed_at;
  const state = runStateOfTurn(conversation.status, turn.state ?? turn.status);
  return {
    op,
    runId: turn.id ?? conversation.id ?? "unknown",
    state,
    startedAt: started,
    ...(ended && state !== "running" ? { endedAt: ended } : {}),
  };
}

/**
 * A conversation that died before its first turn, read back as a run status
 * (#2167). The conversation is all there is — `runId` is its id, because no
 * turn id was ever minted — and `error` carries fountain's own reason.
 */
function statusFromConversation(op: string, conversation: Conversation): OpRunStatus {
  const state: OpRunState = conversation.status === "terminated" ? "cancelled" : "failed";
  const started = conversation.inserted_at ?? new Date(0).toISOString();
  return {
    op,
    runId: conversation.id ?? "unknown",
    state,
    startedAt: started,
    endedAt: conversation.updated_at ?? conversation.last_active_at ?? started,
    ...(state === "failed" ? { error: conversationFailureReason(conversation) } : {}),
  };
}

/** A parsed record read back as a runtime status, the way the local provider does it. */
function statusFromRecord(record: OpRunRecord): OpRunStatus {
  return {
    op: record.op,
    runId: record.id,
    state: runStateOf(record.status),
    startedAt: record.started,
    endedAt: record.ended,
    ...(record.gate ? { gate: record.gate } : {}),
  };
}

/**
 * A record synthesised for a turn whose final message carried none — an op
 * that died before it could print one. `phases: []` says outright that the
 * per-step detail is not known, rather than inventing steps that never ran.
 */
function recordFromTurn(op: string, turn: Turn, conversation: Conversation): OpRunRecord {
  const state = runStateOfTurn(conversation.status, turn.state ?? turn.status);
  return {
    version: 1,
    id: turn.id ?? "unknown",
    op,
    env: "fountain",
    started: turn.started_at ?? turn.created_at ?? new Date(0).toISOString(),
    ended: turn.ended_at ?? turn.completed_at ?? turn.created_at ?? new Date(0).toISOString(),
    status: state === "completed" ? "ok" : "fail",
    labels: {},
    outcomes: {},
    phases: [],
  };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** `{ data: [...] }`, `{ data: { items: [...] } }` or a bare array, all the same to us. */
function listOf<T>(json: unknown): T[] {
  if (Array.isArray(json)) return json as T[];
  if (!isRecord(json)) return [];
  const data = json.data;
  if (Array.isArray(data)) return data as T[];
  if (isRecord(data) && Array.isArray(data.items)) return data.items as T[];
  if (Array.isArray(json.items)) return json.items as T[];
  return [];
}

function objectOf<T>(json: unknown): T | undefined {
  if (!isRecord(json)) return undefined;
  if (isRecord(json.data)) return json.data as T;
  return json as T;
}

/** The error code fountain returns, wherever in the envelope it put it. */
function errorCode(json: unknown): string | undefined {
  if (!isRecord(json)) return undefined;
  if (typeof json.code === "string") return json.code;
  const error = json.error;
  if (typeof error === "string") return error;
  if (isRecord(error) && typeof error.code === "string") return error.code;
  return undefined;
}

function stringField(json: unknown, ...names: string[]): string | undefined {
  if (!isRecord(json)) return undefined;
  for (const name of names) {
    if (typeof json[name] === "string") return json[name];
  }
  const data = json.data;
  if (isRecord(data)) {
    for (const name of names) {
      if (typeof data[name] === "string") return data[name] as string;
    }
  }
  const error = json.error;
  if (isRecord(error)) {
    for (const name of names) {
      if (typeof error[name] === "string") return error[name] as string;
    }
  }
  return undefined;
}

/** The text a block contributes to the turn's final message, if any. */
function blockText(block: Block): string {
  if (block.kind === "text" || block.kind === "agent_message_chunk" || block.kind === "result") {
    return block.body ?? block.text ?? "";
  }
  return "";
}

/** A tool block's identity, so a `tool_call_update` finds the call it settles. */
function toolCallId(block: Block): string {
  return block.tool_call_id ?? block.id ?? block.title ?? block.name ?? "tool";
}

/** What a phase column shows for a tool call: the agent's own words for it. */
function toolCallName(block: Block): string {
  return block.title ?? block.name ?? "tool";
}

const TOOL_START_KINDS = new Set(["tool_call", "tool_use"]);
const TOOL_UPDATE_KINDS = new Set(["tool_call_update", "tool_result"]);
const SETTLED_TOOL_STATUS = new Set(["completed", "failed", "error", "cancelled", "success"]);

// ── The provider ──────────────────────────────────────────────────────────

/** How this run reached fountain, and where the reply will be. */
interface Steward {
  /** Teammate or agent name, as declared. */
  agent: string;
  /** True when the post goes to the team thread — fountain's single-writer path. */
  team: boolean;
  /** Which declaration named it, for an error that can be acted on. */
  via: "steward" | "profile-team" | "param-agent" | "label-agent";
}

/**
 * Build the fountain op-runtime provider.
 *
 * Every call resolves its connection once and caches it: `chant run status`
 * makes one round trip, not one per helper. Nothing is cached across
 * processes, because nothing here is this client's to remember.
 */
export function createFountainOpRuntime(opts: FountainOpRuntimeOptions = {}): OpRuntimeProvider {
  const cwd = opts.cwd ?? process.cwd();
  const now = opts.now ?? (() => Date.now());
  const idleTimeoutMs = opts.idleTimeoutMs ?? envIdleTimeoutMs();

  /** Op configs this process has seen, so `status`/`cancel` know an op's `labels.Agent`. */
  const known = new Map<string, OpConfig>();

  let connection: Promise<{ endpoint: string; token: string; profile?: FountainProfile }> | undefined;

  /**
   * Which `fountain.profiles` entry this provider is currently pointed at.
   * The constructor's is the default; `start` overrides it from
   * `OpRunStartOptions.profile` (`chant run <op> --on fountain --profile
   * staging`, #2124/#2192). One CLI invocation is one run, so switching it
   * only ever drops a connection nothing has used yet.
   */
  let activeProfile = opts.profile;

  const selectProfile = (name: string | undefined): void => {
    if (name === undefined || name === activeProfile) return;
    activeProfile = name;
    connection = undefined; // the next `connect` resolves against the new profile
  };

  const connect = (): Promise<{ endpoint: string; token: string; profile?: FountainProfile }> => {
    connection ??= (async () => {
      let config = opts.config;
      if (!config) {
        try {
          config = (await loadChantConfig(cwd)).config;
        } catch {
          // Not a chant project, or an unreadable config. The environment
          // fallback below still answers; a *named* profile does not, and
          // `resolveConnection` says which variable it wanted.
          config = {} as ChantConfig;
        }
      }
      // `resolveProfile` falls back to `defaultProfile` for a name it does not
      // know (#2124). That is right for an activity and wrong here: silently
      // running against staging because a profile name was misspelt is the one
      // mistake this runtime must not make, so the named entry is checked for
      // existence before the resolver's fallback is accepted.
      if (activeProfile !== undefined && !config.fountain?.profiles?.[activeProfile]) {
        throw new Error(
          `fountain runtime: no profile "${activeProfile}" under fountain.profiles in chant.config.ts. ` +
            `Declare it, or drop the profile name to use fountain.defaultProfile.`,
        );
      }
      const profile = resolveProfile(config, activeProfile);
      try {
        const resolved = await resolveConnection(
          {
            ...(opts.endpoint !== undefined ? { endpoint: opts.endpoint } : {}),
            ...(opts.token !== undefined ? { token: opts.token } : {}),
            ...(activeProfile !== undefined ? { profile: activeProfile } : {}),
            cwd,
          },
          { config },
        );
        return { ...resolved, ...(profile ? { profile } : {}) };
      } catch (err) {
        throw new Error(
          `fountain runtime: ${err instanceof Error ? err.message.replace(/^fountainApply: /, "") : String(err)}. ` +
            `Declare fountain.profiles in chant.config.ts, or set FOUNTAIN_ENDPOINT and FOUNTAIN_TOKEN.`,
        );
      }
    })();
    return connection;
  };

  const rest = async (): Promise<FountainHttp> => {
    if (opts.http) return opts.http;
    const { endpoint, token } = await connect();
    return defaultFountainHttp(endpoint, token);
  };

  const stream = async (): Promise<FountainSse> => {
    if (opts.sse) return opts.sse;
    const { endpoint, token } = await connect();
    return defaultFountainSse(endpoint, token);
  };

  /** The conversation's address, for a message a person has to act on. */
  const conversationUrl = async (id: string): Promise<string> => {
    const { endpoint } = await connect();
    return `${endpoint}/conversations/${id}`;
  };

  const resolveSteward = async (op: OpConfig | undefined, params?: Record<string, unknown>): Promise<Steward> => {
    // A declared `Steward` (#2127) wins: an Op listed in its `ops` goes to
    // that teammate's thread whatever the profile says, because the steward is
    // the declaration that put the Op on that machine in the first place. The
    // registry it fills is only populated when the project's declarations have
    // been loaded into this process — `chant build` and anything that imports
    // the declaration file — so the profile below stays the answer for a bare
    // `chant run <op> --on fountain` in a project that keeps its Ops and its
    // steward in separate modules.
    const declared = op ? stewardForOp(op.name) : undefined;
    if (declared) return { agent: declared, team: true, via: "steward" };

    const { profile } = await connect();
    if (profile?.team) return { agent: profile.team, team: true, via: "profile-team" };

    const param = params?.agent;
    if (typeof param === "string" && param.length > 0) {
      return { agent: param, team: false, via: "param-agent" };
    }

    const label = op?.labels?.Agent;
    if (label) return { agent: label, team: false, via: "label-agent" };

    throw new Error(
      `fountain runtime: no steward for Op "${op?.name ?? "?"}". ` +
        `Set fountain.profiles.<name>.team in chant.config.ts, label the Op \`Agent: "<agent>"\`, ` +
        `or pass --param agent=<agent>.`,
    );
  };

  /**
   * The steward's own thread. For a teammate that is its `fountain:team`
   * conversation; `GET /api/team/:agent_id/conversations` is one round trip
   * for it, which is also what `list` joins several ops over.
   */
  const stewardConversation = async (
    http: FountainHttp,
    steward: Steward,
  ): Promise<Conversation | undefined> => {
    const agentId = await resolveAgentId(http, steward.agent);
    const { status, json } = await http("GET", `/api/team/${agentId}/conversations`);
    if (status !== 200) {
      throw new Error(`fountain runtime: listing "${steward.agent}" conversations failed (${status})`);
    }
    const conversations = listOf<Conversation>(json);
    return conversations.find((c) => c.channel_id === "fountain:team") ?? conversations[0];
  };

  const turnsOf = async (http: FountainHttp, conversationId: string): Promise<Turn[]> => {
    const { status, json } = await http("GET", `/api/conversations/${conversationId}/turns`);
    if (status !== 200) {
      throw new Error(`fountain runtime: reading conversation ${conversationId} turns failed (${status})`);
    }
    return listOf<Turn>(json);
  };

  /** One turn's text, folded out of its blocks — where the run record is. */
  const turnText = async (http: FountainHttp, conversationId: string, turnId: string): Promise<string> => {
    const { status, json } = await http(
      "GET",
      `/api/conversations/${conversationId}/events?turn_id=${encodeURIComponent(turnId)}&blocks=true`,
    );
    if (status !== 200) return "";
    let text = "";
    for (const event of listOf<LogEvent>(json)) {
      for (const block of event.blocks ?? []) text += blockText(block);
    }
    return text;
  };

  /** The steward's thread, its turns for `op`, newest first. */
  const opTurns = async (
    http: FountainHttp,
    op: string,
  ): Promise<{ conversation: Conversation; turns: Turn[]; turnCount: number } | undefined> => {
    const steward = await resolveSteward(known.get(op));
    const conversation = await stewardConversation(http, steward);
    if (!conversation?.id) return undefined;
    const all = await turnsOf(http, conversation.id);
    const turns = all.filter((t) => turnRunsOp(t, op));
    return { conversation, turns: turns.reverse(), turnCount: all.length };
  };

  return {
    name: "fountain",

    async start(op: OpConfig, startOpts: OpRunStartOptions): Promise<OpRunHandle> {
      known.set(op.name, op);
      // Before the first `rest()`, so the endpoint and token this run uses are
      // the named profile's (#2192). Omitted, `defaultProfile` still answers.
      selectProfile(startOpts.profile);
      const http = await rest();
      const steward = await resolveSteward(op, startOpts.params);
      const agentId = await resolveAgentId(http, steward.agent);
      const prompt = runPrompt(op.name);

      const conversationId = steward.team
        ? await postTeamMessage(http, agentId, steward, prompt, conversationUrl)
        : await openConversation(http, agentId, prompt);

      const startedAt = new Date(now()).toISOString();
      const sse = await stream();

      const settled = tailConversation({
        sse,
        conversationId,
        op: op.name,
        startedAt,
        idleTimeoutMs,
        now,
        // The same REST client, so a stream that goes quiet can ask what
        // became of the conversation instead of waiting out the idle
        // timeout on one fountain has already failed (#2167).
        http,
        ...(opts.conversationPollMs !== undefined ? { pollIntervalMs: opts.conversationPollMs } : {}),
        ...(startOpts.progress ? { progress: startOpts.progress } : {}),
        ...(startOpts.signal ? { signal: startOpts.signal } : {}),
      });

      return { op: op.name, runId: conversationId, result: () => settled };
    },

    async status(op: string): Promise<OpRunStatus | undefined> {
      const http = await rest();
      const found = await opTurns(http, op);
      if (!found) return undefined;

      const latest = found.turns[0];
      if (!latest?.id) {
        // No turn to key off. A conversation fountain has already given up on,
        // which never ran a turn at all, is the run: the prompt was accepted
        // and the machine died under it (#2167). Saying "no run is recorded"
        // there sends the reader looking for a run that fountain can describe.
        if (found.turnCount === 0 && conversationIsTerminal(found.conversation.status)) {
          return statusFromConversation(op, found.conversation);
        }
        return undefined;
      }

      const state = runStateOfTurn(found.conversation.status, latest.state ?? latest.status);
      if (state === "running") return statusFromTurn(op, found.conversation, latest);

      const record = parseRunRecord(await turnText(http, found.conversation.id!, latest.id));
      return record ? statusFromRecord(record) : statusFromTurn(op, found.conversation, latest);
    },

    async log(op: string, logOpts?: { limit?: number }): Promise<OpRunRecord[]> {
      const http = await rest();
      const found = await opTurns(http, op);
      if (!found?.conversation.id) return [];

      const turns = logOpts?.limit === undefined ? found.turns : found.turns.slice(0, logOpts.limit);
      const records: OpRunRecord[] = [];
      for (const turn of turns) {
        if (!turn.id) continue;
        const record = parseRunRecord(await turnText(http, found.conversation.id, turn.id));
        records.push(record ?? recordFromTurn(op, turn, found.conversation));
      }
      return records;
    },

    async list(ops: OpConfig[]): Promise<Map<string, OpRunStatus | undefined>> {
      const http = await rest();
      const out = new Map<string, OpRunStatus | undefined>();
      // Group by steward first: the issue's "one GET per steward, joined by op
      // name" is the whole point — a team of twenty ops behind one teammate is
      // one round trip, not twenty.
      const bySteward = new Map<string, { steward: Steward; ops: OpConfig[] }>();
      for (const op of ops) {
        known.set(op.name, op);
        let steward: Steward;
        try {
          steward = await resolveSteward(op);
        } catch {
          // An Op with no steward has no hosted run to report. Say nothing
          // about it rather than failing the whole listing.
          out.set(op.name, undefined);
          continue;
        }
        const key = `${steward.agent}:${steward.team}`;
        const entry = bySteward.get(key);
        if (entry) entry.ops.push(op);
        else bySteward.set(key, { steward, ops: [op] });
      }

      for (const { steward, ops: group } of bySteward.values()) {
        const conversation = await stewardConversation(http, steward);
        const turns = conversation?.id ? (await turnsOf(http, conversation.id)).reverse() : [];
        for (const op of group) {
          const turn = turns.find((t) => turnRunsOp(t, op.name));
          out.set(op.name, turn && conversation ? statusFromTurn(op.name, conversation, turn) : undefined);
        }
      }

      return out;
    },

    async cancel(op: string, cancelOpts: { force: boolean }): Promise<void> {
      const http = await rest();
      const found = await opTurns(http, op);
      const conversationId = found?.conversation.id;
      if (!conversationId) {
        throw new Error(`fountain runtime: no conversation is running Op "${op}" to cancel.`);
      }
      // `interrupt` ends the turn and leaves the machine; `terminate` ends the
      // conversation and takes its sandbox with it. Core's `chant run cancel`
      // requires `--force` as its confirmation and therefore always asks for
      // the second — a caller holding this provider directly gets both.
      const verb = cancelOpts.force ? "terminate" : "interrupt";
      const { status } = await http("POST", `/api/conversations/${conversationId}/${verb}`);
      if (status !== 200 && status !== 202 && status !== 204) {
        throw new Error(`fountain runtime: ${verb} on conversation ${conversationId} failed (${status})`);
      }
    },

    async resolveGate(op: string, gate: string, resolution: GateResolutionRecord): Promise<void> {
      const http = await rest();
      const found = await opTurns(http, op);
      const conversationId = found?.conversation.id;
      if (!conversationId) {
        throw new Error(`fountain runtime: no conversation has run Op "${op}", so there is nothing to wake.`);
      }

      if (opts.durableRequests ?? durableRequestsAsked()) {
        // Stubbed on purpose. Answering the pending permission request needs
        // `POST /api/conversations/:id/requests/:request_id` to be reachable
        // for a *gate*, which is BinaryBourbon/fountain#1635, and that has not
        // shipped. Refusing by name beats posting the prompt anyway and
        // reporting the durable path as taken.
        throw new Error(
          `fountain runtime: --durable-requests needs the request-answer path from BinaryBourbon/fountain#1635, ` +
            `which has not shipped. Drop the flag to post the op's re-run prompt instead ` +
            `(${await conversationUrl(conversationId)}).`,
        );
      }

      // The resolution is already on chant's ledger; this re-runs the op so the
      // sandbox reads it and walks through the gate. The prompt has to be
      // `chant run <op>` for that: the ACP parser (`../acp/command-line.ts`)
      // reads a bare `chant run <name>` as an op run, and reads `chant run
      // approve <op> <gate>` as the approve verb, which would only write the
      // same resolution a second time on the sandbox's local runtime and
      // never re-apply anything (#2192). `--approver` and `--url` ride along
      // so the thread's own transcript names who resolved the gate and where;
      // the run itself decides the gate from the ledger (`evaluateGate` in
      // core's `op/gate.ts`), not from these.
      const parts = [`chant run ${op}`];
      if (resolution.resolvedBy) parts.push(`--approver ${resolution.resolvedBy}`);
      if (resolution.url) parts.push(`--url ${resolution.url}`);
      const { status, json } = await http("POST", `/api/conversations/${conversationId}/prompts`, {
        prompt: parts.join(" "),
      });

      if (status === 400 && errorCode(json) === "conversation_busy") {
        throw new Error(
          `fountain runtime: the steward is running another op, so the re-run prompt was not posted ` +
            `(${await conversationUrl(conversationId)}). Re-run \`chant run approve ${op} ${gate} --on fountain\` when it is idle.`,
        );
      }
      if (status !== 200 && status !== 201 && status !== 202) {
        throw new Error(`fountain runtime: posting the re-run prompt failed (${status})`);
      }
    },
  };
}

/** Was `--durable-requests` asked for on this invocation? */
function durableRequestsAsked(
  argv: string[] = process.argv,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return argv.includes("--durable-requests") || env.FOUNTAIN_DURABLE_REQUESTS === "1";
}

/** `FOUNTAIN_STREAM_IDLE_TIMEOUT`, in seconds, as the fountain CLI reads it. */
function envIdleTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.FOUNTAIN_STREAM_IDLE_TIMEOUT;
  if (!raw) return DEFAULT_STREAM_IDLE_TIMEOUT_MS;
  const seconds = Number(raw);
  return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : DEFAULT_STREAM_IDLE_TIMEOUT_MS;
}

/**
 * `POST /api/team/:agent_id/messages` — the single-writer path. The 202 is not
 * the answer: it carries the conversation id, and everything else arrives on
 * the stream.
 */
async function postTeamMessage(
  http: FountainHttp,
  agentId: string,
  steward: Steward,
  prompt: string,
  urlOf: (id: string) => Promise<string>,
): Promise<string> {
  const { status, json } = await http("POST", `/api/team/${agentId}/messages`, { prompt });

  if (status === 400 && errorCode(json) === "conversation_busy") {
    const conversationId = stringField(json, "conversation_id", "id");
    const where = conversationId ? ` (${await urlOf(conversationId)})` : "";
    throw new Error(
      `fountain runtime: the steward "${steward.agent}" is running another op${where}. ` +
        `A teammate runs one turn at a time; wait for it to finish and run this again.`,
    );
  }
  if (status !== 200 && status !== 201 && status !== 202) {
    throw new Error(`fountain runtime: posting to steward "${steward.agent}" failed (${status})`);
  }

  const conversationId = stringField(json, "conversation_id", "id");
  if (!conversationId) throw new Error("fountain runtime: the steward accepted the prompt but named no conversation");
  return conversationId;
}

/** `POST /api/conversations` — a fresh thread on a named agent. */
async function openConversation(http: FountainHttp, agentId: string, prompt: string): Promise<string> {
  const { status, json } = await http("POST", "/api/conversations", { agent_id: agentId, prompt });
  if (status !== 200 && status !== 201) {
    throw new Error(`fountain runtime: conversation create failed (${status})`);
  }
  const conversationId = stringField(json, "id", "conversation_id");
  if (!conversationId) throw new Error("fountain runtime: conversation create returned no id");
  return conversationId;
}

interface TailOptions {
  sse: FountainSse;
  conversationId: string;
  op: string;
  startedAt: string;
  idleTimeoutMs: number;
  now: () => number;
  progress?: (record: StepRecord) => void;
  signal?: AbortSignal;
  /**
   * REST seam for the conversation poll (#2167). Without it the tail waits on
   * the stream alone, which is what it did before the poll existed.
   */
  http?: FountainHttp;
  /** How much silence asks fountain about the conversation. Default 2s. */
  pollIntervalMs?: number;
}

const IDLE = Symbol("idle");

/**
 * A reader over one connection: `read(ms)` answers the next event, or
 * {@link IDLE} once `ms` has passed without one.
 *
 * The pending `next()` is kept across an IDLE rather than abandoned, so the
 * poll that a quiet stream triggers cannot swallow the event that arrives
 * while it is in flight — a second `next()` on the same iterator would be
 * queued behind the first, and the first would take that event nowhere.
 */
function readerOf<T>(it: AsyncIterator<T>): (ms: number) => Promise<IteratorResult<T> | typeof IDLE> {
  let pending: Promise<IteratorResult<T>> | undefined;
  return async (ms) => {
    if (!pending) {
      pending = it.next();
      // Keep a rejection handled while a poll is awaited elsewhere; the
      // `await` below still sees the rejection.
      void pending.catch(() => undefined);
    }
    if (!Number.isFinite(ms) || ms <= 0) {
      const settled = await pending;
      pending = undefined;
      return settled;
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const result = await Promise.race([
        pending,
        new Promise<typeof IDLE>((res) => {
          timer = setTimeout(() => res(IDLE), ms);
        }),
      ]);
      if (result !== IDLE) pending = undefined;
      return result;
    } finally {
      if (timer) clearTimeout(timer);
    }
  };
}

/**
 * `GET /api/conversations/:id`, or nothing when it cannot be read.
 *
 * The poll is a second opinion on a quiet stream, so a failure to reach it is
 * not a failure of the run: the tail carries on waiting, exactly as it did
 * before the poll existed.
 */
async function readConversation(
  http: FountainHttp,
  conversationId: string,
): Promise<Conversation | undefined> {
  try {
    const { status, json } = await http("GET", `/api/conversations/${conversationId}`);
    if (status !== 200) return undefined;
    return objectOf<Conversation>(json);
  } catch {
    return undefined;
  }
}

/**
 * Tail one conversation to the end of its turn.
 *
 * The loop that matters is the outer one. Fountain closes an idle connection
 * after 60 seconds, so an iterator that ends is the ordinary case rather than
 * an answer: reopen with `Last-Event-ID`, and the server replays what arrived
 * meanwhile. Only the idle deadline — measured across reconnects, not within
 * one connection — ends the wait, and it ends it with an error.
 */
export async function tailConversation(opts: TailOptions): Promise<OpRunStatus> {
  const { sse, conversationId, op, startedAt, idleTimeoutMs, now } = opts;
  const path = `/api/conversations/${conversationId}/stream?streams=stdout,stderr,stage&blocks=true`;

  const seen = new Set<string>();
  const pending = new Map<string, { fn: string; phase: string; startedAt: number }>();
  let text = "";
  let phase = "Run";
  let terminal: string | undefined;
  /** The conversation fountain reported as terminal, when the poll found one. */
  let ended: Conversation | undefined;
  let lastEventId: string | undefined;
  let lastEventAt = now();
  let reconnects = 0;

  const pollMs = opts.http
    ? Math.min(idleTimeoutMs, opts.pollIntervalMs ?? DEFAULT_CONVERSATION_POLL_MS)
    : idleTimeoutMs;

  /** Ask fountain whether the conversation is still alive. True once it isn't. */
  const conversationDied = async (): Promise<boolean> => {
    if (!opts.http) return false;
    const live = await readConversation(opts.http, conversationId);
    if (!live || !conversationIsTerminal(live.status)) return false;
    ended = live;
    return true;
  };

  const emit = (block: Block, status: StepRecord["status"]): void => {
    const key = toolCallId(block);
    const open = pending.get(key);
    pending.delete(key);
    if (!opts.progress) return;
    opts.progress({
      phase: open?.phase ?? phase,
      fn: open?.fn ?? toolCallName(block),
      status,
      durationMs: open ? Math.max(0, now() - open.startedAt) : 0,
    });
  };

  /** Fold one event in. Returns true once the turn has settled. */
  const consume = (event: LogEvent): boolean => {
    if (event.stage && event.stage !== "turn") phase = event.stage;
    if (event.stage === "turn" && event.state && event.state !== "started") {
      terminal = event.state;
    }
    if (event.stage === "terminate") terminal = "interrupted";

    for (const block of event.blocks ?? []) {
      text += blockText(block);
      const kind = block.kind ?? "";
      if (TOOL_START_KINDS.has(kind)) {
        const key = toolCallId(block);
        if (!pending.has(key)) {
          pending.set(key, { fn: toolCallName(block), phase, startedAt: now() });
        }
        if (block.status && SETTLED_TOOL_STATUS.has(block.status)) {
          emit(block, block.status === "completed" || block.status === "success" ? "ok" : "fail");
        }
      } else if (TOOL_UPDATE_KINDS.has(kind)) {
        const status = block.status ?? "completed";
        if (SETTLED_TOOL_STATUS.has(status)) {
          emit(block, status === "completed" || status === "success" ? "ok" : "fail");
        }
      }
    }

    return terminal !== undefined;
  };

  let settled = false;
  while (!settled) {
    if (opts.signal?.aborted) {
      return { op, runId: conversationId, state: "cancelled", startedAt, endedAt: new Date(now()).toISOString() };
    }

    const it = sse(path, {
      ...(lastEventId ? { lastEventId } : {}),
      ...(opts.signal ? { signal: opts.signal } : {}),
    })[Symbol.asyncIterator]();
    const read = readerOf(it);

    for (;;) {
      const step = await read(pollMs);
      if (step === IDLE) {
        // Quiet. Ask fountain about the conversation before blaming patience:
        // one that died during provision emits no turn event, ever (#2167).
        if (now() - lastEventAt < idleTimeoutMs) {
          if (await conversationDied()) break;
          continue;
        }
        throw new Error(
          `fountain runtime: nothing arrived on conversation ${conversationId} for ` +
            `${Math.round(idleTimeoutMs / 1000)}s. The turn is not reported as finished. ` +
            `Widen the wait with FOUNTAIN_STREAM_IDLE_TIMEOUT, in seconds.`,
        );
      }
      if (step.done) break;

      lastEventAt = now();
      const event = step.value;
      if (event.id) {
        if (seen.has(event.id)) continue;
        seen.add(event.id);
        lastEventId = event.id;
      }
      let payload: LogEvent | undefined;
      try {
        payload = objectOf<LogEvent>(JSON.parse(event.data));
      } catch {
        // A heartbeat or a frame this client has no schema for. The stream is
        // still alive, which is the only thing the loop above needed to know.
      }
      if (payload && consume(payload)) {
        settled = true;
        break;
      }
    }

    if (settled || ended) break;
    // The connection ended without a terminal event: fountain's 60-second idle
    // close, or a conversation that has stopped existing. Ask which before
    // reconnecting, then replay from the last id.
    if (await conversationDied()) break;
    if (now() - lastEventAt >= idleTimeoutMs && idleTimeoutMs > 0) {
      throw new Error(
        `fountain runtime: nothing arrived on conversation ${conversationId} for ` +
          `${Math.round(idleTimeoutMs / 1000)}s. The turn is not reported as finished. ` +
          `Widen the wait with FOUNTAIN_STREAM_IDLE_TIMEOUT, in seconds.`,
      );
    }
    if (++reconnects > MAX_RECONNECTS) {
      throw new Error(
        `fountain runtime: conversation ${conversationId} dropped the stream ${MAX_RECONNECTS} times without finishing a turn.`,
      );
    }
  }

  const endedAt = new Date(now()).toISOString();
  const record = parseRunRecord(text);
  if (record) {
    return {
      ...statusFromRecord(record),
      op,
      startedAt,
      endedAt: record.ended || endedAt,
    };
  }

  // The conversation died before the turn could settle (#2167). Fountain's own
  // status is the reason; there is nothing to widen a wait for.
  if (ended && terminal === undefined) {
    const state: OpRunState = ended.status === "terminated" ? "cancelled" : "failed";
    return {
      op,
      runId: conversationId,
      state,
      startedAt,
      endedAt,
      ...(state === "failed" ? { error: conversationFailureReason(ended) } : {}),
    };
  }

  const state: OpRunState =
    terminal === "done" ? "completed" : terminal === "interrupted" ? "cancelled" : "failed";
  return {
    op,
    runId: conversationId,
    state,
    startedAt,
    endedAt,
    ...(state === "failed"
      ? { error: `the turn ended "${terminal ?? "unknown"}" and carried no run record` }
      : {}),
  };
}
