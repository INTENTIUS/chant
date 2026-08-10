/**
 * Render an AgentCore session history as dogwood replay-trace text (#1685).
 *
 * This module is pure: normalized events in, text out, no transport and no
 * filesystem. It exists separately from `./trace-fetch.ts` for two reasons.
 * The Bedrock AgentCore observability surface is in preview and moving, so the
 * thing most likely to be rewritten is the fetch, and the grammar it renders
 * into is the thing least likely to move. And the line grammar has two traps in
 * it that are worth testing byte-for-byte without a mock HTTP stack in the way.
 *
 * ## The grammar
 *
 * From the #1657 verification (§6, read from
 * `dogwood-language/src/interpreter/log_parse.rs` at the pinned SHA
 * `5063bcc2d6d6cf5024d1b0498e6cc8ef52cbcf0c`), one event per line:
 *
 * ```
 * @<timestamp> [scope(principal: <uid>, resource: <uid>)]
 *              [entities(<uid>: { <attrs> } [in [<uid>, …]], …)]
 *              [request_context(<group>: { … }, …)]
 *              <Ns>::Action::"<Name>"::<kind>(<field>: <value>, …)
 * ```
 *
 * The three envelopes are optional and must appear in that order; the trailing
 * group is the logged record. Blank lines are skipped and there is no comment
 * syntax, so a `//` inside a value survives.
 *
 * ## The two traps
 *
 * 1. **`request_context(…)` and the logged record are different bags.** The
 *    Cedar request is built from the first, temporal predicates match against
 *    the second, and a field supplied to only one weakens either the Cedar
 *    check or the temporal check while the replay still exits 0 with a verdict
 *    that looks authoritative. So every payload group an event carries is
 *    written to *both*, always — there is no per-event opt-out here, because an
 *    AgentCore history has no way to express "this field is deliberately
 *    Cedar-invisible". A decision-kind event with no payload at all is a
 *    refusal, not a shrug: see {@link renderAgentCoreTrace}.
 * 2. **Actions must be fully qualified.** `AgentCore::Action::"Transfer"`,
 *    never `Transfer` — a short name leaves the temporal predicate unmatched
 *    while Cedar still authorizes. A bare tool name from the history is
 *    qualified here; an already-qualified one is validated and passed through.
 *
 * ## Decoupling
 *
 * Nothing here imports the cedar lexicon, and the cedar lexicon imports nothing
 * from here. The contract between them is the text. The value and event types
 * below are deliberately shaped so an object built here is *structurally*
 * assignable to the cedar side's `TraceValue`/`TraceEvent` for anyone who wants
 * that, but neither package depends on the other to get it, and the rendering
 * is implemented twice on purpose. Where a choice was free — the space inside
 * `{ … }`, the `, ` between fields, the order of the record's own injections —
 * it matches `lexicons/cedar/src/dogwood/trace.ts` byte for byte, so a trace
 * fetched from AWS and a trace built by hand look the same to a reader and to
 * the parser.
 */

/* ── Values ───────────────────────────────────────────────────────────────── */

/** `Ns::Type::"id"` in value position. */
export interface AgentCoreEntityRef {
  readonly traceValue: "entity";
  readonly uid: string;
}

/** `1.50` — Cedar's decimal surface form, which a JS number cannot carry. */
export interface AgentCoreDecimal {
  readonly traceValue: "decimal";
  readonly text: string;
}

/** Surface text passed through untouched — the escape hatch, used sparingly. */
export interface AgentCoreRaw {
  readonly traceValue: "raw";
  readonly text: string;
}

/** A tagged value: one rendered specially rather than by JS type. */
export type AgentCoreTagged = AgentCoreEntityRef | AgentCoreDecimal | AgentCoreRaw;

/**
 * Which objects are *really* tagged values.
 *
 * Identity, not shape. A tagged value renders as surface text — an `entity`
 * becomes a bare uid, a `raw` becomes its `text` verbatim — so if membership
 * were decided by a `traceValue` key, any agent that wrote
 * `{"traceValue": "raw", "text": "…"}` into a payload could inject arbitrary
 * unescaped text into both bags of the trace: a forged `callerPrincipal`, an
 * unbalanced paren, a whole extra field. The payloads this module reads are
 * written by the agent under observation, which is the last party that should
 * get to decide what its own trace says. So only the three constructors below
 * confer the tag, and {@link renderValue} refuses a record that merely looks
 * tagged rather than rendering it either way.
 */
const TAGGED = new WeakSet<object>();

function tag<T extends AgentCoreTagged>(value: T): T {
  TAGGED.add(value);
  return value;
}

/** Anything that can sit in a trace field, in Cedar surface forms. */
export type AgentCoreTraceValue =
  | string
  | number
  | boolean
  | AgentCoreTagged
  | readonly AgentCoreTraceValue[]
  | { readonly [key: string]: AgentCoreTraceValue };

/** A named group of fields — what one `request_context` envelope entry holds. */
export type AgentCoreFields = { readonly [key: string]: AgentCoreTraceValue };

/** `Ns::Type::"id"`, `Ns::Action::"Name"` — a fully qualified uid. */
const QUALIFIED_UID = /^[A-Za-z_][A-Za-z0-9_]*(::[A-Za-z_][A-Za-z0-9_]*)+::"[^"]*"$/;
/** A bare field, group, namespace or event-kind name. */
const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * A history that cannot become an honest trace.
 *
 * Thrown rather than worked around. Every case this covers is one where the
 * alternative is a trace that replays green and proves less than it looks like
 * it proves, which is the failure mode the whole module is arranged against.
 */
export class AgentCoreTraceError extends Error {
  constructor(
    message: string,
    /** 0-based position in the event list, when one event is to blame. */
    readonly index?: number,
  ) {
    super(message);
    this.name = "AgentCoreTraceError";
  }
}

function assertUid(value: string, what: string, index?: number): string {
  if (!QUALIFIED_UID.test(value)) {
    throw new AgentCoreTraceError(
      `agentcore trace: ${what} must be fully qualified, like Ns::Type::"id" — got "${value}"`,
      index,
    );
  }
  return value;
}

function assertIdent(value: string, what: string, index?: number): string {
  if (!IDENT.test(value)) {
    throw new AgentCoreTraceError(`agentcore trace: ${what} must be an identifier — got "${value}"`, index);
  }
  return value;
}

/** `Ns::Type::"id"`. Validated at construction, so a short name cannot slip through. */
export function agentCoreEntityRef(uid: string): AgentCoreEntityRef {
  return tag({ traceValue: "entity", uid: assertUid(uid, "an entity reference") });
}

/**
 * A Cedar decimal, written as it should appear (`"1.50"`).
 *
 * `context` names the field it came from when there is one, so a payload that
 * cannot be represented says *where* rather than only *what*.
 */
export function agentCoreDecimal(text: string, context?: string): AgentCoreDecimal {
  if (!/^-?\d+\.\d+$/.test(text)) {
    const where = context ? ` at ${context}` : "";
    throw new AgentCoreTraceError(`agentcore trace: a decimal looks like "1.50" — got "${text}"${where}`);
  }
  return tag({ traceValue: "decimal", text });
}

/** Surface text, rendered verbatim. For values this module has no shape for. */
export function agentCoreRaw(text: string): AgentCoreRaw {
  return tag({ traceValue: "raw", text });
}

function isTagged(value: AgentCoreTraceValue): value is AgentCoreTagged {
  return typeof value === "object" && value !== null && TAGGED.has(value);
}

/** The five escapes a Cedar string literal needs. Mirrors the cedar lexicon's. */
function escapeString(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r")
    .replace(/\t/g, "\\t");
}

/** Render one value in the Cedar surface form the trace parser reads. */
export function renderValue(value: AgentCoreTraceValue): string {
  if (typeof value === "string") return `"${escapeString(value)}"`;
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    if (!Number.isInteger(value)) {
      throw new AgentCoreTraceError(
        `agentcore trace: ${String(value)} is not an integer — a decimal must be written with agentCoreDecimal("1.50") so its scale survives`,
      );
    }
    // Beyond 2^53 a JS number has already lost the digits an i64 would keep,
    // and `String(1e21)` is `"1e+21"`, which is not a Cedar integer literal at
    // all. Either way the trace would carry a number that is not the number the
    // agent saw.
    if (!Number.isSafeInteger(value)) {
      throw new AgentCoreTraceError(
        `agentcore trace: ${String(value)} is outside the range a JS number represents exactly, so the trace would carry a different number than the history did — carry it as a string`,
      );
    }
    return String(value);
  }
  if (Array.isArray(value)) return `[${value.map(renderValue).join(", ")}]`;
  if (isTagged(value)) return value.traceValue === "entity" ? value.uid : value.text;
  if ("traceValue" in value) {
    // See TAGGED. Rendering it as a record would be a lie about what the agent
    // wrote; rendering it as a tagged value would let the agent write its own
    // trace. Neither is on offer.
    throw new AgentCoreTraceError(
      `agentcore trace: a payload carries a "traceValue" field, which is the marker this module uses for entity refs, decimals and raw surface text. ` +
        "Rendering it either way would let the observed agent decide what its own trace says, so it is refused — rename the field at the source, " +
        "or build the value with agentCoreEntityRef/agentCoreDecimal/agentCoreRaw.",
    );
  }
  return renderFields(value as AgentCoreFields);
}

/** `{ a: 1, b: "x" }` — a record body, braces included. */
export function renderFields(fields: AgentCoreFields): string {
  const parts = Object.entries(fields).map(
    ([key, value]) => `${assertIdent(key, "a trace field name")}: ${renderValue(value)}`,
  );
  return `{ ${parts.join(", ")} }`;
}

/* ── Normalized events ────────────────────────────────────────────────────── */

/**
 * One decision-relevant thing that happened in an AgentCore session, in the
 * shape the fetch normalizes to and the renderer reads.
 *
 * This is deliberately *not* the dogwood event shape. It is the semantic shape
 * of an agent session — who acted, on what, with which payload — so that a
 * change to the observability surface under preview churn is a change to the
 * mapping in `./trace-fetch.ts` and not to the grammar below.
 */
export interface AgentCoreSessionEvent {
  /** When it happened, epoch **milliseconds**. Converted to the trace's i64 here. */
  readonly timeMs: number;
  /** The session it belongs to. Lands in the logged record as `sessionId`. */
  readonly sessionId: string;
  /** Unique within the session. Lands in the logged record as `requestId`. */
  readonly eventId: string;
  /**
   * The dogwood event kind. `request` / `response` / `error` conventionally;
   * the truth is whichever kinds the project's `.dwschema` marks `decision`,
   * and that file is not visible from here.
   */
  readonly kind: string;
  /**
   * The tool or operation. A bare name (`"Transfer"`) is qualified with the
   * namespace; an already-qualified `Ns::Action::"Name"` is validated and used
   * as-is. Never rendered short.
   */
  readonly action: string;
  /** Who acted — an actor id, or a fully qualified uid to override the type. */
  readonly actor: string;
  /** What was acted on — a runtime/gateway id, or a fully qualified uid. */
  readonly target: string;
  /** The call's input payload. Lands in both bags as the `input` group. */
  readonly input?: AgentCoreFields;
  /** The call's result. Lands in both bags as the `output` group. */
  readonly output?: AgentCoreFields;
  /** A failure's detail. Lands in both bags as the `error` group. */
  readonly error?: AgentCoreFields;
  /**
   * Anything the source carried that has no field of its own. Lands in both
   * bags as the `attributes` group.
   */
  readonly attributes?: AgentCoreFields;
}

/** How `@<i64>` is derived from `timeMs`. */
export type AgentCoreTimeOrigin =
  /** Epoch seconds. Absolute, comparable across sessions, large numbers. */
  | "epoch-seconds"
  /** Seconds since the earliest event, so the first line reads `@0`. */
  | "relative-seconds";

/** What {@link renderAgentCoreTrace} takes. */
export interface AgentCoreTraceOptions {
  /** Cedar namespace for actions and entity types. Default `"AgentCore"`. */
  readonly namespace?: string;
  /** Entity type for `actor`. Default `"Actor"`. */
  readonly principalType?: string;
  /** Entity type for `target`. Default `"Runtime"`. */
  readonly resourceType?: string;
  /** Default `"epoch-seconds"`. */
  readonly origin?: AgentCoreTimeOrigin;
  /**
   * Kinds that produce a decision, and so build a Cedar request. Default
   * `["request"]`, the convention the default event schema follows. A
   * history-only event never becomes a Cedar request, so an absent payload on
   * one is not a weakening.
   */
  readonly decisionKinds?: readonly string[];
  /** Weakenings to tolerate. Empty by default — see {@link renderAgentCoreTrace}. */
  readonly allow?: readonly AgentCoreTraceIssueKind[];
}

/** What {@link auditAgentCoreEvents} can find. */
export type AgentCoreTraceIssueKind =
  /** A decision-kind event with no payload: the Cedar request carries no context. */
  | "no-request-context"
  /** Two events in one session sharing an id: `requestId` stops identifying anything. */
  | "duplicate-event-id";

/** One finding against a normalized history. */
export interface AgentCoreTraceIssue {
  readonly kind: AgentCoreTraceIssueKind;
  /** 0-based position in the *sorted* event list. */
  readonly index: number;
  readonly timeMs: number;
  readonly message: string;
}

const DEFAULTS = {
  namespace: "AgentCore",
  principalType: "Actor",
  resourceType: "Runtime",
  origin: "epoch-seconds" as AgentCoreTimeOrigin,
  decisionKinds: ["request"] as readonly string[],
};

/** A payload group name → the field on the normalized event. Order is the render order. */
const GROUPS = ["input", "output", "error", "attributes"] as const;

function payloadGroups(event: AgentCoreSessionEvent): Record<string, AgentCoreFields> {
  const out: Record<string, AgentCoreFields> = {};
  for (const group of GROUPS) {
    const fields = event[group];
    if (fields && Object.keys(fields).length > 0) out[group] = fields;
  }
  return out;
}

/**
 * `Ns::Action::"Name"` from a bare tool name, or a qualified action validated.
 *
 * The fully-qualified requirement is the second §6 trap: a short name leaves
 * every temporal predicate unmatched while Cedar still authorizes, so the
 * replay is green and blind.
 */
export function qualifyAction(action: string, namespace: string, index?: number): string {
  if (action.includes("::")) return assertUid(action, "a trace action", index);
  if (action.length === 0 || action.includes('"')) {
    throw new AgentCoreTraceError(
      `agentcore trace: a bare action name cannot be empty or contain a quote — got "${action}"`,
      index,
    );
  }
  return `${assertIdent(namespace, "a namespace", index)}::Action::"${action}"`;
}

/** `Ns::Type::"id"` from a bare id, or a qualified uid validated. */
export function qualifyUid(id: string, namespace: string, type: string, what: string, index?: number): string {
  if (id.includes("::")) return assertUid(id, what, index);
  if (id.length === 0 || id.includes('"')) {
    throw new AgentCoreTraceError(
      `agentcore trace: ${what} cannot be empty or contain a quote — got "${id}"`,
      index,
    );
  }
  return `${assertIdent(namespace, "a namespace", index)}::${assertIdent(type, "an entity type", index)}::"${id}"`;
}

/**
 * Order the history the way the interpreter reads it.
 *
 * dogwood accumulates history in *file* order, so an out-of-order line changes
 * what a temporal window sees. A fetch that pages backwards (CloudWatch Logs
 * hands out the newest first) would otherwise produce a trace whose windows are
 * quietly wrong, so ordering is settled here rather than being a caller's
 * problem. Ties keep their original relative order.
 */
function sortByTime(events: readonly AgentCoreSessionEvent[]): AgentCoreSessionEvent[] {
  return events.map((event, index) => ({ event, index }))
    .sort((a, b) => a.event.timeMs - b.event.timeMs || a.index - b.index)
    .map(({ event }) => event);
}

function assertWellFormed(event: AgentCoreSessionEvent, index: number): void {
  if (typeof event.timeMs !== "number" || !Number.isFinite(event.timeMs)) {
    throw new AgentCoreTraceError(
      `agentcore trace: event ${index} has no usable timestamp (${String(event.timeMs)}) — a trace timepoint is an i64 and there is no honest default for a missing one`,
      index,
    );
  }
  for (const [field, value] of [
    ["sessionId", event.sessionId],
    ["eventId", event.eventId],
    ["actor", event.actor],
    ["target", event.target],
    ["action", event.action],
    ["kind", event.kind],
  ] as const) {
    if (typeof value !== "string" || value.length === 0) {
      throw new AgentCoreTraceError(
        `agentcore trace: event ${index} has no ${field} — the history is malformed, and a trace with a guessed ${field} replays green while proving nothing`,
        index,
      );
    }
  }
}

/**
 * The weakening checks, applied to a normalized history.
 *
 * Everything here is something that makes a replay *weaker* rather than
 * something that makes it fail, which is exactly the class a green replay run
 * hides. Structural malformation throws instead: see {@link AgentCoreTraceError}.
 */
export function auditAgentCoreEvents(
  events: readonly AgentCoreSessionEvent[],
  options: AgentCoreTraceOptions = {},
): AgentCoreTraceIssue[] {
  const decisionKinds = new Set(options.decisionKinds ?? DEFAULTS.decisionKinds);
  const issues: AgentCoreTraceIssue[] = [];
  const seen = new Set<string>();

  sortByTime(events).forEach((event, index) => {
    assertWellFormed(event, index);
    const at = { index, timeMs: event.timeMs };

    if (decisionKinds.has(event.kind) && Object.keys(payloadGroups(event)).length === 0) {
      issues.push({
        ...at,
        kind: "no-request-context",
        message: `${event.action}::${event.kind} carries no input, output, error or attributes, so its request_context envelope would be empty and every context.* test in a policy silently misses`,
      });
    }

    const key = `${event.sessionId} ${event.eventId}`;
    if (seen.has(key)) {
      issues.push({
        ...at,
        kind: "duplicate-event-id",
        message: `session ${event.sessionId} reports eventId "${event.eventId}" twice, so requestId no longer identifies a decision point and an expectation written against one addresses both`,
      });
    }
    seen.add(key);
  });

  return issues;
}

/* ── Rendering ────────────────────────────────────────────────────────────── */

/** One line's worth: the envelopes and the logged record, fully resolved. */
export interface AgentCoreTraceLine {
  readonly timestamp: number;
  readonly action: string;
  readonly kind: string;
  readonly scope: { readonly principal: string; readonly resource: string };
  readonly requestContext: AgentCoreFields;
  readonly record: AgentCoreFields;
}

/**
 * Resolve one normalized event into the envelopes and the logged record.
 *
 * Both bags get every payload group; the record additionally gets the event
 * schema's own injections (`callerPrincipal`, `callerResource`, `sessionId`,
 * `requestId`), which are never part of the Cedar request. Field order matches
 * the §6 example line: groups first, then the injections.
 */
export function toTraceLine(
  event: AgentCoreSessionEvent,
  timestamp: number,
  options: AgentCoreTraceOptions = {},
  index?: number,
): AgentCoreTraceLine {
  const namespace = options.namespace ?? DEFAULTS.namespace;
  const principal = qualifyUid(
    event.actor,
    namespace,
    options.principalType ?? DEFAULTS.principalType,
    "an actor",
    index,
  );
  const resource = qualifyUid(
    event.target,
    namespace,
    options.resourceType ?? DEFAULTS.resourceType,
    "a target",
    index,
  );
  const groups = payloadGroups(event);

  return {
    timestamp,
    action: qualifyAction(event.action, namespace, index),
    kind: assertIdent(event.kind, "an event kind", index),
    scope: { principal, resource },
    requestContext: groups,
    record: {
      ...groups,
      callerPrincipal: agentCoreEntityRef(principal),
      callerResource: agentCoreEntityRef(resource),
      sessionId: event.sessionId,
      requestId: event.eventId,
    },
  };
}

/** One line as the trace parser reads it. Never ends in a newline. */
export function renderTraceLine(line: AgentCoreTraceLine): string {
  if (!Number.isSafeInteger(line.timestamp)) {
    throw new AgentCoreTraceError(`agentcore trace: a timepoint is an i64 — got ${String(line.timestamp)}`);
  }

  const parts = [`@${line.timestamp}`];
  parts.push(`scope(principal: ${line.scope.principal}, resource: ${line.scope.resource})`);

  const context = Object.entries(line.requestContext).map(
    ([group, value]) => `${assertIdent(group, "a request-context group")}: ${renderValue(value)}`,
  );
  if (context.length > 0) parts.push(`request_context(${context.join(", ")})`);

  const record = Object.entries(line.record).map(
    ([key, value]) => `${assertIdent(key, "a trace field name")}: ${renderValue(value)}`,
  );
  parts.push(`${line.action}::${line.kind}(${record.join(", ")})`);

  return parts.join(" ");
}

/** A rendered trace, and what the audit tolerated on the way. */
export interface AgentCoreTrace {
  /** The text, one event per line, newline-terminated. */
  readonly text: string;
  /** The resolved lines, in render order. */
  readonly lines: readonly AgentCoreTraceLine[];
  /** Findings the caller allowed. Empty unless `allow` named something. */
  readonly issues: readonly AgentCoreTraceIssue[];
}

/**
 * Render a normalized AgentCore history as dogwood trace text.
 *
 * The inversion of the §6 traps: every payload group lands in both bags, every
 * action comes out fully qualified, the history is ordered the way the
 * interpreter reads it, and a history that would produce a weakened trace
 * throws instead. Naming a kind in `allow` is how a caller says the weakening
 * is the point — the alternative was a trace that replays green and proves
 * less than it looks like it proves.
 */
export function renderAgentCoreTrace(
  events: readonly AgentCoreSessionEvent[],
  options: AgentCoreTraceOptions = {},
): AgentCoreTrace {
  const sorted = sortByTime(events);
  // The audit runs `assertWellFormed` over the same sorted list, so a
  // structurally broken history throws here before anything is rendered.
  const issues = auditAgentCoreEvents(sorted, options);
  const allow = new Set(options.allow ?? []);
  const blocking = issues.filter((issue) => !allow.has(issue.kind));
  if (blocking.length > 0) {
    const detail = blocking.map((i) => `  [${i.kind}] event ${i.index}: ${i.message}`).join("\n");
    const kinds = [...new Set(blocking.map((i) => `"${i.kind}"`))].join(", ");
    throw new AgentCoreTraceError(
      `agentcore trace: this history would weaken its own replay rather than fail it:\n${detail}\n` +
        `Fix the history, or pass { allow: [${kinds}] } to say the weakening is the point.`,
    );
  }

  const origin = options.origin ?? DEFAULTS.origin;
  const base = origin === "relative-seconds" && sorted.length > 0 ? (sorted[0]?.timeMs ?? 0) : 0;
  const lines = sorted.map((event, index) =>
    toTraceLine(event, Math.floor((event.timeMs - base) / 1000), options, index),
  );

  // An empty history renders as empty text, not as a bare newline: dogwood
  // skips blank lines, so the two replay identically, and "" is the honest
  // answer to "what did this session do". Whether an empty trace is worth
  // replaying is the caller's call — see `trace-fetch.ts`'s `requireEvents`.
  const text = lines.length > 0 ? lines.map(renderTraceLine).join("\n") + "\n" : "";
  return { text, lines, issues };
}
