/**
 * `awsAgentCoreFetchTrace` — pull a Bedrock AgentCore session history and
 * render it as dogwood replay-trace text (#1685, follow-on from #1682).
 *
 * Contributed the way the fly lexicon contributes `flyApply` and the cedar
 * lexicon contributes `dogwoodReplay`: a plain exported async function taking
 * one args object, re-exported from `src/op/activities/index.ts`, resolved **by
 * name** by core's activity registry when a project lists the `aws` lexicon.
 * No Temporal import beneath it, so the local executor runs it unchanged and a
 * Temporal worker registers the same function. Transport is injectable through
 * the same `AwsReadHttp` seam `src/api/read-client.ts` already uses, so tests
 * never touch the network and `endpoint` retargets the whole thing.
 *
 * The output is text. The cedar lexicon's `PolicyReplayOp` reads a trace from
 * `tracePath`, so `outPath` here is the handoff — and it is the *only* handoff.
 * Neither package imports the other; the decoupling contract is the grammar.
 *
 * ## Which AgentCore surface actually carries decision history
 *
 * Investigated before building, because the answer changes what can be shipped.
 * Verified against the live API reference and devguide on 2026-08-10:
 *
 * - **There is no `GetTrace`, no `GetSession`, and no `ListRuntimeSessions`.**
 *   The `bedrock-agentcore` data plane (API version 2024-02-28) publishes
 *   `StopRuntimeSession` with no read counterpart — a runtime session can be
 *   killed but not enumerated. `bedrock-agentcore-control` (2023-06-05) is
 *   resource CRUD only.
 *   <https://docs.aws.amazon.com/bedrock-agentcore/latest/APIReference/API_Operations.html>
 * - **AgentCore Memory is the one fetchable session history**, and it is what
 *   this module reads: `ListSessions`
 *   (`POST /memories/{memoryId}/actor/{actorId}/sessions`) and `ListEvents`
 *   (`POST /memories/{memoryId}/actor/{actorId}/sessions/{sessionId}`), both
 *   paginated, with a `payload[]` of `conversational` (roles `ASSISTANT`,
 *   `USER`, `TOOL`, `OTHER`) or `blob` members.
 *   <https://docs.aws.amazon.com/bedrock-agentcore/latest/APIReference/API_ListEvents.html>
 *   <https://docs.aws.amazon.com/bedrock-agentcore/latest/APIReference/API_PayloadType.html>
 *   The caveat is load-bearing and is repeated in {@link AgentCoreMemorySource}:
 *   Memory holds what the agent *wrote* via `CreateEvent`. It is a store, not a
 *   service-side audit. An agent that never writes leaves nothing to replay.
 * - **The service's own per-tool-call and per-decision records are CloudWatch
 *   Logs, not an API.** Gateway `tools/call` bodies land in
 *   `/aws/vendedlogs/bedrock-agentcore/gateway/APPLICATION_LOGS/{gateway_id}`;
 *   the allow/deny itself lives in `aws/spans` span attributes
 *   (`aws.agentcore.policy.authorization_decision` = `ALLOW`|`DENY`,
 *   `…determining_policies`, `…effects`, `…temporal.event_timestamp_ns`).
 *   <https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/observability-gateway-metrics.html>
 *   <https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/observability-policy-metrics.html>
 *   Both are reachable only through CloudWatch Logs Insights / X-Ray
 *   Transaction Search, and the gateway record's `requestBody` is a Java map
 *   `toString` (`{id=1, jsonrpc=2.0, method=tools/call, params={…}}`) rather
 *   than JSON. Those two sources are therefore *named and refused* here rather
 *   than guessed at — see {@link AgentCoreTraceUnavailableError}. An honest
 *   partial beats an invented API.
 * - **No emulator serves any of it.** Floci's service index lists no
 *   `bedrock-agentcore` at all (its only Bedrock entry is a `bedrock-runtime`
 *   stub), and MiniStack implements twelve control-plane runtime/endpoint
 *   operations and states that Memory, Gateway, Identity and the rest are not
 *   implemented. A control-plane emulator is structurally incapable of serving
 *   decision history anyway, since every per-call record lives in CloudWatch.
 *   So the testable path today is the injected transport, and the mocked
 *   fixtures in `./trace-fetch.test.ts` are the contract.
 *
 * ## Signing
 *
 * Requests go out unsigned, exactly like `awsApply`'s and `read-client.ts`'s.
 * Real AWS rejects them; an endpoint override does not. SigV4 rides #1686, and
 * when it lands this module needs only its `http` default swapped.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { AwsReadError, serviceUrl, type AwsReadHttp } from "../api/read-client";
import {
  agentCoreDecimal,
  renderAgentCoreTrace,
  AgentCoreTraceError,
  type AgentCoreFields,
  type AgentCoreSessionEvent,
  type AgentCoreTimeOrigin,
  type AgentCoreTraceIssue,
  type AgentCoreTraceIssueKind,
  type AgentCoreTraceValue,
} from "./trace-render";

const SERVICE = "bedrock-agentcore";
const DEFAULT_MAX_EVENTS = 1_000;
/** `ListEvents` bounds `maxResults` at 100. */
const PAGE_SIZE = 100;

/* ── Sources ──────────────────────────────────────────────────────────────── */

/**
 * Where a history is read from.
 *
 * Only `memory` is implemented, and the reason the other two are named rather
 * than omitted is that "which surface carries this" is the question #1685 asked
 * first. A caller who reaches for `spans` gets the finding, not a 404.
 */
export type AgentCoreTraceSource =
  /** AgentCore Memory `ListEvents`. The one fetchable session history. */
  | "memory"
  /** Gateway vended `tools/call` logs. CloudWatch-only, and not JSON. */
  | "gateway-logs"
  /** `aws/spans` policy-decision span attributes. CloudWatch/X-Ray-only. */
  | "spans";

/** Marker type for the documented Memory caveat. See the module header. */
export type AgentCoreMemorySource = Extract<AgentCoreTraceSource, "memory">;

/**
 * A source that exists in AWS but is not reachable the way this module reads.
 *
 * The message names the finding and the surface, so a caller who hits it knows
 * whether they are blocked on chant or on AWS. Both current cases are the
 * latter: the record is real, it is in CloudWatch Logs, and getting at it is a
 * Logs Insights integration rather than an AgentCore API call.
 */
export class AgentCoreTraceUnavailableError extends Error {
  constructor(
    readonly source: AgentCoreTraceSource,
    message: string,
  ) {
    super(message);
    this.name = "AgentCoreTraceUnavailableError";
  }
}

const UNAVAILABLE: Record<Exclude<AgentCoreTraceSource, "memory">, string> = {
  "gateway-logs":
    "AgentCore Gateway does not publish an API that returns per-invocation tool calls. " +
    "The record exists, vended to CloudWatch Logs at " +
    "/aws/vendedlogs/bedrock-agentcore/gateway/APPLICATION_LOGS/{gateway_id}, but its requestBody " +
    "field is a Java map toString ({id=1, jsonrpc=2.0, method=tools/call, params={…}}) rather than " +
    "JSON, so reading it is a CloudWatch Logs Insights integration with its own parser, not a fetch. " +
    'Use source: "memory" (AgentCore Memory ListEvents), or file the Logs Insights source as its own issue. ' +
    "See https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/observability-gateway-metrics.html",
  spans:
    "AgentCore policy decisions are not returned by any published API. AuthorizeAction and " +
    "PartiallyAuthorizeActions appear only as a CloudWatch metric dimension; the per-call allow/deny " +
    "lives in aws.agentcore.policy.authorization_decision on spans in the aws/spans log group, " +
    "readable through CloudWatch Logs Insights or xray:StartTraceRetrieval and requiring Transaction " +
    'Search. Use source: "memory" for the tool-call history a replay actually needs — a replay ' +
    "recomputes the verdict from the policy set, so the recorded decision is a comparison input, not " +
    "a trace input. See https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/observability-policy-metrics.html",
};

/* ── The Memory wire shapes ───────────────────────────────────────────────── */

/** One `payload[]` member, as `ListEvents` returns it. */
export interface MemoryPayloadMember {
  readonly conversational?: { readonly role?: string; readonly content?: unknown };
  readonly blob?: unknown;
}

/** One event, as `ListEvents` returns it. Fields this module does not read are ignored. */
export interface MemoryEvent {
  readonly eventId?: string;
  readonly sessionId?: string;
  readonly actorId?: string;
  readonly memoryId?: string;
  /** restJson1 timestamp: epoch seconds (possibly fractional) or an ISO-8601 string. */
  readonly eventTimestamp?: number | string;
  readonly metadata?: unknown;
  readonly payload?: readonly MemoryPayloadMember[];
  readonly branch?: { readonly name?: string; readonly rootEventId?: string };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/* ── Time ─────────────────────────────────────────────────────────────────── */

/**
 * Epoch milliseconds from whatever the wire carried.
 *
 * restJson1 renders a `timestamp` shape as epoch **seconds**, possibly
 * fractional, but the docs' examples and several SDK paths show ISO-8601, so
 * both are accepted. A bare number is disambiguated by magnitude: anything at
 * or beyond 1e12 is already milliseconds (1e12 ms is 2001; 1e12 s is the year
 * 33658), so the heuristic has no realistic collision. Anything else throws
 * rather than being coerced — a guessed timestamp puts every temporal window in
 * the replay in the wrong place.
 */
export function toEpochMs(value: unknown, what: string): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value >= 1e12 ? Math.round(value) : Math.round(value * 1000);
  }
  if (typeof value === "string" && value.length > 0) {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  throw new AgentCoreTraceError(
    `agentcore trace: ${what} is not a usable timestamp (${JSON.stringify(value)}) — the history is malformed, and a guessed timepoint moves every temporal window in the replay`,
  );
}

/* ── JSON → trace values ──────────────────────────────────────────────────── */

/** What to do with a payload key the trace grammar cannot spell. */
export type NonIdentifierFieldPolicy = "rename" | "fail";

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** `tool-name` → `tool_name`, `2fa` → `f_2fa`. Deterministic, so goldens hold. */
export function identifierFor(key: string): string {
  const cleaned = key.replace(/[^A-Za-z0-9_]/g, "_");
  return IDENT.test(cleaned) ? cleaned : `f_${cleaned}`;
}

/** A key the coercion had to rewrite, reported so a rename is never silent. */
export interface FieldRename {
  readonly path: string;
  readonly from: string;
  readonly to: string;
}

/**
 * Coerce arbitrary JSON into trace values.
 *
 * Three decisions worth naming. A non-integer number becomes a Cedar decimal
 * rather than being rounded, because the scale is the thing a policy compares
 * against. `null` and `undefined` are dropped, because Cedar has no null and an
 * invented sentinel would be matched by a predicate that meant something else.
 * And a key the grammar cannot spell is renamed — but every rename is returned,
 * so a caller can see it, and `onNonIdentifierField: "fail"` refuses instead.
 */
export function coerceFields(
  value: unknown,
  options: { onNonIdentifierField?: NonIdentifierFieldPolicy } = {},
  path = "",
  renames: FieldRename[] = [],
): { fields: AgentCoreFields; renames: FieldRename[] } {
  const fields: Record<string, AgentCoreTraceValue> = {};
  if (!isRecord(value)) return { fields, renames };

  for (const [key, raw] of Object.entries(value)) {
    const coerced = coerceValue(raw, options, path ? `${path}.${key}` : key, renames);
    if (coerced === undefined) continue;
    let name = key;
    if (!IDENT.test(key)) {
      if (options.onNonIdentifierField === "fail") {
        throw new AgentCoreTraceError(
          `agentcore trace: the payload field "${path ? `${path}.` : ""}${key}" is not an identifier and the dogwood trace grammar cannot spell it — rename it at the source, or accept the rewrite by leaving onNonIdentifierField unset`,
        );
      }
      name = identifierFor(key);
      renames.push({ path: path ? `${path}.${key}` : key, from: key, to: name });
    }
    fields[name] = coerced;
  }
  return { fields, renames };
}

function coerceValue(
  value: unknown,
  options: { onNonIdentifierField?: NonIdentifierFieldPolicy },
  path: string,
  renames: FieldRename[],
): AgentCoreTraceValue | undefined {
  if (value === null || value === undefined) return undefined;
  if (typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return undefined;
    return Number.isInteger(value) ? value : agentCoreDecimal(String(value));
  }
  if (Array.isArray(value)) {
    const items: AgentCoreTraceValue[] = [];
    value.forEach((item, index) => {
      const coerced = coerceValue(item, options, `${path}[${index}]`, renames);
      if (coerced !== undefined) items.push(coerced);
    });
    return items;
  }
  if (isRecord(value)) return coerceFields(value, options, path, renames).fields;
  return undefined;
}

/* ── Memory → normalized events ───────────────────────────────────────────── */

/**
 * How a `conversational` role becomes an action and an event kind.
 *
 * The default is a convention, not a contract AWS publishes — `Conversational`
 * carries a role and content and nothing else, so the tool name, if there is
 * one, is inside the content the agent wrote. Override it per project.
 */
export interface RoleMapping {
  readonly action: string;
  readonly kind: string;
}

/** Default role mapping. `TOOL` is a decision-kind `request`: it is the call being authorized. */
export const DEFAULT_ROLE_MAPPING: Readonly<Record<string, RoleMapping>> = {
  USER: { action: "Prompt", kind: "request" },
  ASSISTANT: { action: "Respond", kind: "response" },
  TOOL: { action: "InvokeTool", kind: "request" },
  OTHER: { action: "Event", kind: "request" },
};

/**
 * The `blob` convention this module reads.
 *
 * A `blob` payload is arbitrary JSON, so there is nothing to parse until
 * someone agrees on a shape. This is that shape, and it is the one worth
 * writing from `CreateEvent`: `action` and `kind` decide the trace's grammar
 * slots, `input`/`output`/`error` become the payload groups that land in both
 * bags, and everything else becomes `attributes`. Every key is optional; an
 * absent `action` falls back to the role mapping's `OTHER`.
 */
export const BLOB_KEYS = ["action", "kind", "input", "output", "error"] as const;

/** Options shared by the normalizer and the activity. */
export interface AgentCoreNormalizeOptions {
  /** Overrides merged over {@link DEFAULT_ROLE_MAPPING}. */
  readonly roles?: Readonly<Record<string, RoleMapping>>;
  /** Cedar resource id for every event. Default: the event's `memoryId`. */
  readonly target?: string;
  /** Default `"rename"`. */
  readonly onNonIdentifierField?: NonIdentifierFieldPolicy;
}

/** A normalized history plus whatever the coercion had to rewrite. */
export interface NormalizedHistory {
  readonly events: readonly AgentCoreSessionEvent[];
  readonly renames: readonly FieldRename[];
}

/**
 * `ListEvents` output → the renderer's normalized events. Pure: no transport.
 *
 * One event with N payload members becomes N normalized events sharing the
 * event's timestamp, with `#0`, `#1`, … appended to the id — the trace's
 * `requestId` has to identify a decision point, and a two-member event is two
 * decision points. A member that is neither `conversational` nor `blob` is a
 * shape this module does not know, and it throws rather than being skipped:
 * a silently dropped tool call is a temporal predicate that silently misses.
 */
export function normalizeMemoryEvents(
  events: readonly MemoryEvent[],
  options: AgentCoreNormalizeOptions = {},
): NormalizedHistory {
  const roles = { ...DEFAULT_ROLE_MAPPING, ...(options.roles ?? {}) };
  const renames: FieldRename[] = [];
  const out: AgentCoreSessionEvent[] = [];

  events.forEach((event, index) => {
    const where = `event ${index}${event.eventId ? ` (${event.eventId})` : ""}`;
    const timeMs = toEpochMs(event.eventTimestamp, `${where}'s eventTimestamp`);
    const members = event.payload ?? [];
    if (members.length === 0) {
      throw new AgentCoreTraceError(
        `agentcore trace: ${where} has an empty payload — either includePayloads was false or the history is truncated, and a payload-less trace replays green while proving nothing`,
        index,
      );
    }

    members.forEach((member, slot) => {
      const suffix = members.length > 1 ? `#${slot}` : "";
      const base = {
        timeMs,
        sessionId: event.sessionId ?? "",
        eventId: `${event.eventId ?? ""}${suffix}`,
        actor: event.actorId ?? "",
        target: options.target ?? event.memoryId ?? "",
      };

      if (member.conversational) {
        const role = member.conversational.role ?? "OTHER";
        const mapping = roles[role] ?? roles.OTHER!;
        const content = coerceFields(
          isRecord(member.conversational.content)
            ? member.conversational.content
            : { text: member.conversational.content },
          options,
          `${where}.payload[${slot}].conversational.content`,
          renames,
        ).fields;
        out.push({
          ...base,
          action: mapping.action,
          kind: mapping.kind,
          ...(Object.keys(content).length > 0 ? { input: content } : {}),
          attributes: { role },
        });
        return;
      }

      if (member.blob !== undefined) {
        const blob = isRecord(member.blob) ? member.blob : { value: member.blob };
        const prefix = `${where}.payload[${slot}].blob`;
        const rest: Record<string, unknown> = {};
        for (const [key, value] of Object.entries(blob)) {
          if (!(BLOB_KEYS as readonly string[]).includes(key)) rest[key] = value;
        }
        const groups = {
          input: coerceFields(blob.input, options, `${prefix}.input`, renames).fields,
          output: coerceFields(blob.output, options, `${prefix}.output`, renames).fields,
          error: coerceFields(blob.error, options, `${prefix}.error`, renames).fields,
          attributes: coerceFields(rest, options, prefix, renames).fields,
        };
        out.push({
          ...base,
          action: typeof blob.action === "string" && blob.action.length > 0 ? blob.action : roles.OTHER!.action,
          kind: typeof blob.kind === "string" && blob.kind.length > 0 ? blob.kind : roles.OTHER!.kind,
          ...(Object.keys(groups.input).length > 0 ? { input: groups.input } : {}),
          ...(Object.keys(groups.output).length > 0 ? { output: groups.output } : {}),
          ...(Object.keys(groups.error).length > 0 ? { error: groups.error } : {}),
          ...(Object.keys(groups.attributes).length > 0 ? { attributes: groups.attributes } : {}),
        });
        return;
      }

      throw new AgentCoreTraceError(
        `agentcore trace: ${where}.payload[${slot}] is neither conversational nor blob — PayloadType is a union of exactly those two, so this is a shape change or a corrupt record, and skipping it would drop a decision point from the replay`,
        index,
      );
    });
  });

  return { events: out, renames };
}

/* ── Transport ────────────────────────────────────────────────────────────── */

const defaultHttp: AwsReadHttp = async (url, init, signal) => {
  const res = await fetch(url, { method: "POST", headers: init.headers, body: init.body, signal });
  return { status: res.status, text: await res.text() };
};

/** Where to read from and how to reach it. */
export interface AgentCoreReadOptions {
  /** Endpoint override. Omit for the real regional host. */
  readonly endpoint?: string;
  /** Default `us-east-1`. */
  readonly region?: string;
}

async function agentCorePost(
  path: string,
  body: Record<string, unknown>,
  options: AgentCoreReadOptions,
  http: AwsReadHttp,
  signal?: AbortSignal,
): Promise<Record<string, unknown>> {
  const base = serviceUrl(SERVICE, options.endpoint, options.region);
  const res = await http(
    `${base}${path.replace(/^\//, "")}`,
    { headers: { "content-type": "application/json" }, body: JSON.stringify(body) },
    signal,
  );

  let parsed: unknown;
  try {
    parsed = JSON.parse(res.text);
  } catch {
    throw new AwsReadError(`unparseable ${SERVICE} response for ${path}`, res.status);
  }
  const payload = isRecord(parsed) ? parsed : {};
  const type = typeof payload.__type === "string" ? payload.__type.split("#").pop() : undefined;
  if (type || res.status >= 400) {
    const message = typeof payload.message === "string" ? payload.message : `${path} failed with HTTP ${res.status}`;
    throw new AwsReadError(message, res.status, type);
  }
  return payload;
}

/** Path-segment encoding for the Memory REST routes. */
function segment(value: string, what: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new AgentCoreTraceError(`agentcore trace: ${what} is required to read a session history`);
  }
  return encodeURIComponent(value);
}

/** What {@link listMemoryEvents} takes. */
export interface ListMemoryEventsArgs extends AgentCoreReadOptions {
  readonly memoryId: string;
  readonly actorId: string;
  readonly sessionId: string;
  /** Stop after this many events. Default 1000 — a runaway session is not a trace. */
  readonly maxEvents?: number;
}

/**
 * `ListEvents` for one session, paginated to exhaustion or to `maxEvents`.
 *
 * `includePayloads` is always true: without it the response carries event ids
 * and timestamps and nothing to match a predicate against, which is a trace
 * that replays green and proves nothing.
 */
export async function listMemoryEvents(
  args: ListMemoryEventsArgs,
  signal?: AbortSignal,
  http: AwsReadHttp = defaultHttp,
): Promise<MemoryEvent[]> {
  const path =
    `memories/${segment(args.memoryId, "memoryId")}` +
    `/actor/${segment(args.actorId, "actorId")}` +
    `/sessions/${segment(args.sessionId, "sessionId")}`;
  const cap = args.maxEvents ?? DEFAULT_MAX_EVENTS;

  const out: MemoryEvent[] = [];
  let nextToken: string | undefined;
  do {
    const body = await agentCorePost(
      path,
      {
        includePayloads: true,
        maxResults: Math.min(PAGE_SIZE, cap - out.length),
        ...(nextToken ? { nextToken } : {}),
      },
      args,
      http,
      signal,
    );
    const events = Array.isArray(body.events) ? (body.events as MemoryEvent[]) : [];
    out.push(...events);
    nextToken = typeof body.nextToken === "string" && body.nextToken.length > 0 ? body.nextToken : undefined;
    if (events.length === 0) break;
  } while (nextToken && out.length < cap);

  return out.slice(0, cap);
}

/* ── The activity ─────────────────────────────────────────────────────────── */

/** What {@link awsAgentCoreFetchTrace} takes. */
export interface AwsAgentCoreFetchTraceArgs extends AgentCoreReadOptions, AgentCoreNormalizeOptions {
  /** Default `"memory"`. The other two are named and refused — see the module header. */
  readonly source?: AgentCoreTraceSource;
  /** AgentCore Memory resource id. */
  readonly memoryId: string;
  /** Actor whose sessions are being read. */
  readonly actorId: string;
  /** The session to replay. */
  readonly sessionId: string;
  /**
   * Window start, inclusive. Read by {@link toEpochMs}, the same function the
   * event timestamps go through — so epoch seconds, epoch milliseconds, or
   * anything `Date.parse` reads, and a bound is never on a different scale
   * from the events it is being compared against.
   */
  readonly since?: number | string;
  /** Window end, inclusive. Read the same way as {@link since}. */
  readonly until?: number | string;
  /** Cap on events fetched before the window filter. Default 1000. */
  readonly maxEvents?: number;

  /** Cedar namespace for actions and entity types. Default `"AgentCore"`. */
  readonly namespace?: string;
  /** Entity type for the actor. Default `"Actor"`. */
  readonly principalType?: string;
  /** Entity type for the target. Default `"Runtime"`. */
  readonly resourceType?: string;
  /** Default `"epoch-seconds"`. */
  readonly origin?: AgentCoreTimeOrigin;
  /** Kinds that build a Cedar request. Default `["request"]`. */
  readonly decisionKinds?: readonly string[];
  /** Weakenings to tolerate. Empty by default. */
  readonly allow?: readonly AgentCoreTraceIssueKind[];

  /** Write the rendered trace here — what `PolicyReplayOp`'s `tracePath` reads. */
  readonly outPath?: string;
  /** Throw when the window produced no events. Default `true`. */
  readonly requireEvents?: boolean;
}

/** What {@link awsAgentCoreFetchTrace} returns. */
export interface AwsAgentCoreFetchTraceResult {
  readonly source: AgentCoreTraceSource;
  readonly sessionId: string;
  /** The rendered trace, one event per line, newline-terminated. */
  readonly text: string;
  /** Lines in the trace — decision points plus history-only events. */
  readonly lineCount: number;
  /** Events `ListEvents` returned before the window filter. */
  readonly fetched: number;
  /** Absolute path written, when `outPath` was given. */
  readonly outPath?: string;
  /** Payload keys the trace grammar could not spell, rewritten and reported. */
  readonly renames: readonly FieldRename[];
  /** Weakenings the caller allowed. Empty unless `allow` named something. */
  readonly issues: readonly AgentCoreTraceIssue[];
}

function windowBound(value: number | string | undefined, what: string): number | undefined {
  if (value === undefined) return undefined;
  return toEpochMs(value, what);
}

/**
 * Fetch an AgentCore session history and render it as dogwood trace text.
 *
 * The window is applied after the fetch on purpose: `ListEvents`' `filter` takes
 * a branch and event metadata and has no time predicate, so a server-side
 * window is not on offer. `maxEvents` bounds the fetch; `since`/`until` bound
 * what is rendered.
 */
export async function awsAgentCoreFetchTrace(
  args: AwsAgentCoreFetchTraceArgs,
  signal?: AbortSignal,
  http: AwsReadHttp = defaultHttp,
): Promise<AwsAgentCoreFetchTraceResult> {
  const source = args.source ?? "memory";
  if (source !== "memory") {
    const detail = UNAVAILABLE[source];
    if (!detail) {
      throw new AgentCoreTraceUnavailableError(source, `agentcore trace: unknown source "${String(source)}"`);
    }
    throw new AgentCoreTraceUnavailableError(source, `agentcore trace: ${detail}`);
  }

  const raw = await listMemoryEvents(args, signal, http);
  const since = windowBound(args.since, "the window's `since`");
  const until = windowBound(args.until, "the window's `until`");

  const { events, renames } = normalizeMemoryEvents(raw, args);
  const windowed = events.filter(
    (event) => (since === undefined || event.timeMs >= since) && (until === undefined || event.timeMs <= until),
  );

  if (windowed.length === 0 && (args.requireEvents ?? true)) {
    const window = since !== undefined || until !== undefined ? " in the requested window" : "";
    throw new AgentCoreTraceError(
      `agentcore trace: session ${args.sessionId} has no events${window} (${raw.length} fetched). ` +
        "AgentCore Memory holds what the agent wrote through CreateEvent, not a service-side audit, so an " +
        "agent that never writes leaves nothing to replay. Pass requireEvents: false to accept an empty trace.",
    );
  }

  const { text, lines, issues } = renderAgentCoreTrace(windowed, args);

  let written: string | undefined;
  if (args.outPath) {
    written = resolve(args.outPath);
    await mkdir(dirname(written), { recursive: true });
    await writeFile(written, text, "utf8");
  }

  return {
    source,
    sessionId: args.sessionId,
    text,
    lineCount: lines.length,
    fetched: raw.length,
    ...(written ? { outPath: written } : {}),
    renames,
    issues,
  };
}
