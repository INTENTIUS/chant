/**
 * Typed construction of dogwood replay traces (#1661, epic #1646).
 *
 * A trace is one event per line, and the line grammar recorded by the #1657
 * verification (§6, read from `dogwood-language/src/interpreter/log_parse.rs`
 * at the pinned SHA) is:
 *
 * ```
 * @<timestamp> [scope(principal: <uid>, resource: <uid>)]
 *              [entities(<uid>: { <attrs> } [in [<uid>, …]], …)]
 *              [request_context(<group>: { … }, …)]
 *              <Ns>::Action::"<Name>"::<kind>(<field>: <value>, …)
 * ```
 *
 * The three envelopes are optional and must appear in that order; the trailing
 * group is the logged record. There is no comment syntax — a `//` is an
 * ordinary part of a value, so URLs survive — blank lines are skipped, and a
 * leading BOM is stripped.
 *
 * Two things in that format silently weaken a replay rather than failing it,
 * and both are what this module exists to make hard:
 *
 * 1. **`request_context(…)` and the logged record are different bags.** The
 *    Cedar request is built from the first; temporal predicates match against
 *    the second. A field needed by both and supplied to only one weakens
 *    either the Cedar check or the temporal check, and the replay still exits
 *    0 with a verdict that looks authoritative. So {@link traceEvent} writes a
 *    `context` group into *both* bags by default, and dropping one is an
 *    explicit per-event `bags` opt-out that has to be typed out.
 * 2. **Actions must be fully qualified.** `Drupe::Action::"Transfer"`, never
 *    `Transfer` — a short name leaves the temporal predicate unmatched while
 *    Cedar still authorizes. {@link traceEvent} rejects anything that is not
 *    `Ns::…::"Name"` at construction.
 *
 * {@link auditTrace} is the same two checks applied to a trace this module did
 * not build — the AgentCore session history #1661 leaves to the aws lexicon,
 * or a `.log` recorded by hand. A trace is a trace, wherever it came from.
 */

import { escapeCedarString } from "../policy-text";

// ── Names ─────────────────────────────────────────────────────────

/** `Drupe::Action::"Read"`, `Drupe::OAuthUser::"alice"` — a qualified uid. */
const QUALIFIED_UID = /^[A-Za-z_][A-Za-z0-9_]*(::[A-Za-z_][A-Za-z0-9_]*)+::"[^"]*"$/;
/** A bare field, group or event-kind name. */
const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;

function assertUid(value: string, what: string): string {
  if (!QUALIFIED_UID.test(value)) {
    throw new Error(`dogwood: ${what} must be fully qualified, like Ns::Type::"id" — got "${value}"`);
  }
  return value;
}

function assertIdent(value: string, what: string): string {
  if (!IDENT.test(value)) throw new Error(`dogwood: ${what} must be an identifier — got "${value}"`);
  return value;
}

// ── Values ────────────────────────────────────────────────────────

/** `Ns::Type::"id"` in value position. */
export interface TraceEntityRef {
  readonly traceValue: "entity";
  readonly uid: string;
}

/** `1.50` — Cedar's decimal surface form, which a JS number cannot carry. */
export interface TraceDecimal {
  readonly traceValue: "decimal";
  readonly text: string;
}

/** Surface text passed through untouched — the escape hatch, used sparingly. */
export interface TraceRaw {
  readonly traceValue: "raw";
  readonly text: string;
}

/** A tagged value: one this module renders specially rather than by JS type. */
export type TraceTagged = TraceEntityRef | TraceDecimal | TraceRaw;

/** Anything that can sit in a trace field, in Cedar surface forms. */
export type TraceValue =
  | string
  | number
  | boolean
  | TraceTagged
  | readonly TraceValue[]
  | { readonly [key: string]: TraceValue };

/** A named group of fields — what one `request_context` envelope entry holds. */
export type TraceFields = { readonly [key: string]: TraceValue };

/** `Ns::Type::"id"`. Validated at construction, so a short name cannot slip through. */
export function entityRef(uid: string): TraceEntityRef {
  return { traceValue: "entity", uid: assertUid(uid, "an entity reference") };
}

/** A Cedar decimal, written as it should appear (`"1.50"`). */
export function decimalValue(text: string): TraceDecimal {
  if (!/^-?\d+\.\d+$/.test(text)) {
    throw new Error(`dogwood: a trace decimal looks like "1.50" — got "${text}"`);
  }
  return { traceValue: "decimal", text };
}

/** Surface text, rendered verbatim. For values this module has no shape for. */
export function rawValue(text: string): TraceRaw {
  return { traceValue: "raw", text };
}

function isTagged(value: TraceValue): value is TraceTagged {
  return typeof value === "object" && value !== null && !Array.isArray(value) && "traceValue" in value;
}

/** Render one value in the Cedar surface form the trace parser reads. */
export function renderTraceValue(value: TraceValue): string {
  if (typeof value === "string") return `"${escapeCedarString(value)}"`;
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    if (!Number.isInteger(value)) {
      throw new Error(
        `dogwood: ${String(value)} is not an integer — a trace decimal must be written with decimalValue("1.50") so its scale survives`,
      );
    }
    return String(value);
  }
  if (Array.isArray(value)) return `[${value.map(renderTraceValue).join(", ")}]`;
  if (isTagged(value)) {
    if (value.traceValue === "entity") return value.uid;
    if (value.traceValue === "decimal") return value.text;
    return value.text;
  }
  return renderTraceFields(value as TraceFields);
}

/** `{ a: 1, b: "x" }` — a record body, braces included. */
export function renderTraceFields(fields: TraceFields): string {
  const parts = Object.entries(fields).map(
    ([key, value]) => `${assertIdent(key, "a trace field name")}: ${renderTraceValue(value)}`,
  );
  return `{ ${parts.join(", ")} }`;
}

// ── Envelopes ─────────────────────────────────────────────────────

/** The `scope(principal: …, resource: …)` envelope. Both are entity uids. */
export interface TraceScope {
  readonly principal: string;
  readonly resource: string;
}

/** One `entities(…)` entry: a uid, its attributes, and its parents. */
export interface TraceEntityDecl {
  readonly uid: string;
  readonly attrs?: TraceFields;
  /** `in [<uid>, …]` — the entity's parents in the hierarchy. */
  readonly parents?: readonly string[];
}

/** `Ns::Type::"id": { … } in [ … ]`. */
export function traceEntity(uid: string, attrs?: TraceFields, parents?: readonly string[]): TraceEntityDecl {
  return {
    uid: assertUid(uid, "an entity declaration"),
    ...(attrs ? { attrs } : {}),
    ...(parents ? { parents: parents.map((p) => assertUid(p, "an entity parent")) } : {}),
  };
}

// ── Events ────────────────────────────────────────────────────────

/**
 * One trace line, fully resolved: every envelope decided, both bags settled.
 *
 * Built by {@link traceEvent} rather than by hand — the constructor is where
 * the both-bags default and the qualified-action check live. The type stays
 * public because a trace fetched from somewhere else (an AgentCore session
 * history, a recorded `.log`) is normalized into it and then handed to
 * {@link auditTrace}.
 */
export interface TraceEvent {
  /** The `i64` after `@`. */
  readonly timestamp: number;
  /** Fully qualified: `Ns::Action::"Name"`. */
  readonly action: string;
  /** `request`, `response`, `error` conventionally — author-defined in truth. */
  readonly kind: string;
  /** The trailing logged record — what temporal predicates match against. */
  readonly record: TraceFields;
  /** The `request_context(…)` envelope — what the Cedar request is built from. */
  readonly requestContext?: TraceFields;
  readonly scope?: TraceScope;
  readonly entities?: readonly TraceEntityDecl[];
}

/**
 * Which bags a `context` group lands in.
 *
 * `both` is the default and the only one that keeps a replay honest. The other
 * two exist so a test can *demonstrate* the weakening rather than only
 * describe it, and so a trace that genuinely has no Cedar-side counterpart for
 * a field can say so out loud instead of by omission.
 */
export type TraceBags = "both" | "record-only" | "context-only";

/** What {@link traceEvent} takes. */
export interface TraceEventInput {
  readonly timestamp: number;
  /** Fully qualified: `Ns::Action::"Name"`. A short name throws. */
  readonly action: string;
  /** Default `request` — the only kind the default event schema decides on. */
  readonly kind?: string;
  /**
   * Named field groups (`input`, `output`, …). Each lands in **both** the
   * `request_context` envelope and the logged record unless {@link bags} says
   * otherwise.
   */
  readonly context?: { readonly [group: string]: TraceFields };
  /**
   * Fields that belong to the logged record only — `callerPrincipal`,
   * `callerResource`, `requestId`, `sessionId` and the rest of the event
   * schema's own injections. These are never part of the Cedar request.
   */
  readonly record?: TraceFields;
  readonly scope?: TraceScope;
  readonly entities?: readonly TraceEntityDecl[];
  /** Explicit opt-out of both-bag population. See {@link TraceBags}. */
  readonly bags?: TraceBags;
}

/**
 * Build one trace event with both bags populated.
 *
 * Every `context` group is written to the `request_context` envelope *and*
 * merged into the logged record, because that is the only combination in which
 * the Cedar check and the temporal check both see the field. Dropping one is a
 * typed decision (`bags`), not an omission.
 */
export function traceEvent(input: TraceEventInput): TraceEvent {
  const action = assertUid(input.action, "a trace action");
  const kind = assertIdent(input.kind ?? "request", "an event kind");
  const bags = input.bags ?? "both";

  const groups = input.context ?? {};
  for (const group of Object.keys(groups)) assertIdent(group, "a request-context group");

  const record: Record<string, TraceValue> = {};
  if (bags !== "context-only") Object.assign(record, groups);
  Object.assign(record, input.record ?? {});

  const context: Record<string, TraceValue> = {};
  if (bags !== "record-only") Object.assign(context, groups);

  return {
    timestamp: input.timestamp,
    action,
    kind,
    record,
    ...(Object.keys(context).length > 0 ? { requestContext: context } : {}),
    ...(input.scope
      ? {
          scope: {
            principal: assertUid(input.scope.principal, "a scope principal"),
            resource: assertUid(input.scope.resource, "a scope resource"),
          },
        }
      : {}),
    ...(input.entities && input.entities.length > 0 ? { entities: input.entities } : {}),
  };
}

// ── Rendering ─────────────────────────────────────────────────────

function renderScope(scope: TraceScope): string {
  return `scope(principal: ${scope.principal}, resource: ${scope.resource})`;
}

function renderEntities(entities: readonly TraceEntityDecl[]): string {
  const parts = entities.map((e) => {
    const attrs = renderTraceFields(e.attrs ?? {});
    const parents = e.parents && e.parents.length > 0 ? ` in [${e.parents.join(", ")}]` : "";
    return `${e.uid}: ${attrs}${parents}`;
  });
  return `entities(${parts.join(", ")})`;
}

function renderGroups(fields: TraceFields): string {
  const parts = Object.entries(fields).map(
    ([group, value]) => `${assertIdent(group, "a request-context group")}: ${renderTraceValue(value)}`,
  );
  return `request_context(${parts.join(", ")})`;
}

/** One event as the single line the trace parser reads. Never ends in a newline. */
export function renderTraceLine(event: TraceEvent): string {
  if (!Number.isInteger(event.timestamp)) {
    throw new Error(`dogwood: a trace timestamp is an i64 — got ${String(event.timestamp)}`);
  }

  const parts = [`@${event.timestamp}`];
  if (event.scope) parts.push(renderScope(event.scope));
  if (event.entities && event.entities.length > 0) parts.push(renderEntities(event.entities));
  if (event.requestContext && Object.keys(event.requestContext).length > 0) {
    parts.push(renderGroups(event.requestContext));
  }

  const record = Object.entries(event.record).map(
    ([key, value]) => `${assertIdent(key, "a trace field name")}: ${renderTraceValue(value)}`,
  );
  parts.push(`${event.action}::${event.kind}(${record.join(", ")})`);

  return parts.join(" ");
}

/** A whole trace, one event per line, newline-terminated. */
export function renderTrace(events: readonly TraceEvent[]): string {
  return events.map(renderTraceLine).join("\n") + "\n";
}

// ── Auditing a trace this module did not build ────────────────────

/** What {@link auditTrace} can find. */
export type TraceIssueKind =
  | "single-bag"
  | "no-request-context"
  | "empty-record"
  | "out-of-order";

/** One finding against a trace, indexed by its position in the event list. */
export interface TraceIssue {
  readonly kind: TraceIssueKind;
  /** 0-based position in the event list — a trace has no line numbers of its own. */
  readonly index: number;
  readonly timestamp: number;
  readonly message: string;
}

/** Options for {@link auditTrace} and {@link traceFixture}. */
export interface TraceAuditOptions {
  /**
   * Event kinds that produce a decision, and so build a Cedar request.
   *
   * Default `["request"]`, which is the convention the default event schema
   * follows — the truth is whichever kinds the project's `.dwschema` marks
   * `decision`, and that file is not visible from here. A history-only event
   * never becomes a Cedar request, so an absent `request_context` on one is
   * not a weakening and is not reported.
   */
  readonly decisionKinds?: readonly string[];
}

/**
 * The both-bags and ordering checks, applied to any trace.
 *
 * Every finding here is something that makes a replay *weaker* rather than
 * something that makes it fail — which is exactly the class a green replay run
 * hides. A trace built by {@link traceEvent} produces none of them unless a
 * `bags` opt-out was taken deliberately.
 */
export function auditTrace(events: readonly TraceEvent[], options: TraceAuditOptions = {}): TraceIssue[] {
  const issues: TraceIssue[] = [];
  const decisionKinds = new Set(options.decisionKinds ?? ["request"]);
  let previous: number | undefined;

  events.forEach((event, index) => {
    const at = { index, timestamp: event.timestamp };
    const context = event.requestContext ?? {};
    const contextKeys = Object.keys(context);
    const decides = decisionKinds.has(event.kind);

    if (decides && contextKeys.length === 0) {
      issues.push({
        ...at,
        kind: "no-request-context",
        message: `${event.action}::${event.kind} has no request_context envelope, so the Cedar request it is evaluated against carries no context — every context.* test in a policy silently misses`,
      });
    }

    for (const group of contextKeys) {
      if (!(group in event.record)) {
        issues.push({
          ...at,
          kind: "single-bag",
          message: `${event.action}::${event.kind} puts "${group}" in request_context but not in the logged record, so temporal predicates over ${group}.* silently miss`,
        });
      }
    }

    for (const group of Object.keys(event.record)) {
      // Only groups (records) are candidates for the Cedar side; the event
      // schema's own scalar injections (callerPrincipal, requestId, …) belong
      // to the logged record alone and are not a single-bag finding.
      const value = event.record[group];
      const isGroup = typeof value === "object" && value !== null && !Array.isArray(value) && !isTagged(value);
      if (decides && isGroup && contextKeys.length > 0 && !(group in context)) {
        issues.push({
          ...at,
          kind: "single-bag",
          message: `${event.action}::${event.kind} puts "${group}" in the logged record but not in request_context, so context.${group}.* is absent from the Cedar request`,
        });
      }
    }

    if (Object.keys(event.record).length === 0) {
      issues.push({
        ...at,
        kind: "empty-record",
        message: `${event.action}::${event.kind} logs no fields at all, so no temporal predicate can match it`,
      });
    }

    if (previous !== undefined && event.timestamp < previous) {
      issues.push({
        ...at,
        kind: "out-of-order",
        message: `timestamp ${event.timestamp} follows ${previous} — the interpreter accumulates history in file order, so an out-of-order line changes what a window sees`,
      });
    }
    previous = event.timestamp;
  });

  return issues;
}

// ── Fixtures ──────────────────────────────────────────────────────

/** Options for {@link traceFixture}. */
export interface TraceFixtureOptions extends TraceAuditOptions {
  /**
   * Issue kinds to tolerate. Empty by default: a fixture that weakens its own
   * replay throws at build time rather than producing a green run that proves
   * nothing.
   */
  readonly allow?: readonly TraceIssueKind[];
}

/** A built trace: the events, the text, and whatever the audit tolerated. */
export interface TraceFixture {
  readonly events: readonly TraceEvent[];
  readonly text: string;
  readonly issues: readonly TraceIssue[];
}

/**
 * Assemble events into trace text, refusing to produce a weakened one.
 *
 * The inversion of the trap: the default is a trace that populates both bags,
 * and every way of getting a weaker one — a `bags` opt-out on an event, a
 * hand-normalized event with an empty record — has to be named in `allow`
 * before this will hand it back.
 */
export function traceFixture(
  events: readonly TraceEvent[],
  options: TraceFixtureOptions = {},
): TraceFixture {
  const allow = new Set(options.allow ?? []);
  const issues = auditTrace(events, options);
  const blocking = issues.filter((i) => !allow.has(i.kind));

  if (blocking.length > 0) {
    const detail = blocking.map((i) => `  [${i.kind}] @${i.timestamp}: ${i.message}`).join("\n");
    throw new Error(
      `dogwood: this trace would weaken its own replay rather than fail it:\n${detail}\n` +
        `Fix the events, or pass { allow: [${[...new Set(blocking.map((i) => `"${i.kind}"`))].join(", ")}] } to say the weakening is the point.`,
    );
  }

  return { events, text: renderTrace(events), issues };
}
