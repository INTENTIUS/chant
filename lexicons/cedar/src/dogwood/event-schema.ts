/**
 * Typed authoring for the `.dwschema` event-schema DSL.
 *
 * The `.dwschema`/`.cedarschema` question the epic flagged was a false alarm
 * (#1657 §2): they are the two halves of one schema. The required half is the
 * Cedar action schema (`--policy-schema`); this file is the optional half, the
 * service side, which says what event *kinds* exist and what fields each one
 * carries. Upstream's grammar is 136 lines of pest and is purely syntactic —
 * it never consults an action schema, which is why every declaration is
 * written against a symbolic action binder `<A>`:
 *
 * ```
 * decision event <A>::request {
 *     ...inputs(A),
 *     pin callerPrincipal: principalType(A) = principal,
 *     callerResource:      resourceType(A),
 *     requestId:           String,
 * }
 * ```
 *
 * That symbolic binder is why DWDC010 can check an event *kind* against the
 * emitted schema but not an action: the schema names no actions at all.
 *
 * ## The pin, and why opting out is explicit here
 *
 * `ServiceSchema::defaults()` — what runs when no `--event-schema` is passed —
 * pins `callerPrincipal = principal` on every kind, so every temporal
 * predicate is correlated to the current request's principal and events from
 * other principals are invisible. Supplying *any* event schema opts out of the
 * default wholesale, so a schema emitted without that pin silently widens
 * every temporal predicate in the policy set to cross-principal.
 *
 * {@link defaultEventSchema} therefore carries the pin, and dropping it takes
 * a named argument (`pinCallerPrincipal: false`) that also stamps a comment
 * into the emitted file. DWDS010 reports the resulting schema either way, so
 * the choice is visible in the build and not only in the source.
 */

import { renderWindow, window, type TemporalWindow, type WindowLike } from "./window";

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;
const TYPE_NAME = /^[A-Za-z_][A-Za-z0-9_]*(::[A-Za-z_][A-Za-z0-9_]*)*$/;

function assertIdent(value: string, what: string): string {
  if (!IDENT.test(value)) throw new Error(`dogwood: ${what} must be an identifier — got "${value}"`);
  return value;
}

// ── Field types ───────────────────────────────────────────────────

/** The four selectors that read from the bound action. */
export type EventSelector = "inputs" | "outputs" | "principalType" | "resourceType";

/** `principalType(A)`, a nested `{ … }` record, or a concrete Cedar type. */
export type EventFieldType =
  | { readonly type: "selector"; readonly selector: EventSelector }
  | { readonly type: "record"; readonly fields: readonly EventField[] }
  | { readonly type: "concrete"; readonly name: string };

/** `principalType(A)` — the action's principal entity type. */
export function principalType(): EventFieldType {
  return { type: "selector", selector: "principalType" };
}

/** `resourceType(A)` — the action's resource entity type. */
export function resourceType(): EventFieldType {
  return { type: "selector", selector: "resourceType" };
}

/** `String`, `Long`, `MyApp::OAuthUser` — a concrete (possibly qualified) type. */
export function concrete(name: string): EventFieldType {
  if (!TYPE_NAME.test(name)) throw new Error(`dogwood: a field type must be a Cedar type name — got "${name}"`);
  return { type: "concrete", name };
}

/** `{ … }` — the named field becomes a group addressed as `name.member`. */
export function record(fields: EventField[]): EventFieldType {
  return { type: "record", fields };
}

// ── Pins ──────────────────────────────────────────────────────────

/**
 * The right-hand side of a pin: the request-side value the field is forced to
 * match. `principal`/`resource` (with an optional attribute tail) or a
 * `context.<path>`.
 */
export type PinTarget =
  | { readonly ref: "principal" | "resource"; readonly attrs: readonly string[] }
  | { readonly ref: "context"; readonly path: readonly string[] };

/** `= principal`, or `= principal.dept`. */
export function pinPrincipal(...attrs: string[]): PinTarget {
  for (const a of attrs) assertIdent(a, "a pin attribute");
  return { ref: "principal", attrs };
}

/** `= resource`, or `= resource.owner`. */
export function pinResource(...attrs: string[]): PinTarget {
  for (const a of attrs) assertIdent(a, "a pin attribute");
  return { ref: "resource", attrs };
}

/** `= context.input.user`. At least one path segment; `context` alone is not a pin. */
export function pinContext(path: string): PinTarget {
  const segments = path.split(".");
  if (segments.length === 0 || segments[0] === "") {
    throw new Error("dogwood: a context pin needs at least one path segment (context.<field>)");
  }
  for (const s of segments) assertIdent(s, "a context pin segment");
  return { ref: "context", path: segments };
}

// ── Fields ────────────────────────────────────────────────────────

/** `...inputs(A)` / `...outputs(A)` — splice every field the selector yields. */
export interface SpreadField {
  readonly field: "spread";
  readonly selector: Extract<EventSelector, "inputs" | "outputs">;
}

/** `[pin] name: <type> [= <pin target>]`. */
export interface NamedField {
  readonly field: "named";
  readonly name: string;
  readonly type: EventFieldType;
  readonly pin?: PinTarget;
}

/** One entry in an event declaration's field list. */
export type EventField = SpreadField | NamedField;

/** `...inputs(A)`. */
export function spreadInputs(): SpreadField {
  return { field: "spread", selector: "inputs" };
}

/** `...outputs(A)`. */
export function spreadOutputs(): SpreadField {
  return { field: "spread", selector: "outputs" };
}

/** `name: <type>` — an injected field with an explicit type. */
export function field(name: string, type: EventFieldType): NamedField {
  return { field: "named", name: assertIdent(name, "a field name"), type };
}

/**
 * `pin name: <type> = <target>` — a correlation against the decision request.
 *
 * Upstream requires the `pin` prefix and the `= …` clause together, and a
 * pinned field must be a leaf (never a record type), so both are enforced here
 * rather than deferred to the parser.
 */
export function pinnedField(name: string, type: EventFieldType, target: PinTarget): NamedField {
  if (type.type === "record") {
    throw new Error(`dogwood: a pinned field must be a leaf, and "${name}" is a record type`);
  }
  return { field: "named", name: assertIdent(name, "a field name"), type, pin: target };
}

// ── Declarations ──────────────────────────────────────────────────

/** `[decision] event <A>::kind { fields }`. */
export interface EventDeclaration {
  /** `request`, `response`, `error`, or anything the author chooses. */
  readonly kind: string;
  /** True for the kind that carries the authorization decision. */
  readonly decision?: boolean;
  readonly fields: readonly EventField[];
  /** Emitted as `// …` above the declaration. */
  readonly comment?: string;
}

/** One `event` declaration. */
export function eventDeclaration(
  kind: string,
  fields: EventField[],
  options: { decision?: boolean; comment?: string } = {},
): EventDeclaration {
  return { kind: assertIdent(kind, "an event kind"), fields, decision: options.decision, comment: options.comment };
}

/** A whole `.dwschema` file. */
export interface EventSchema {
  /** `max_window = 30d`. Omitted means upstream's 24h default applies. */
  readonly maxWindow?: TemporalWindow;
  /** The action binder name, `A` by convention. */
  readonly binder: string;
  readonly events: readonly EventDeclaration[];
  /** Header comment lines, emitted above everything. */
  readonly comment?: string;
}

/** Assemble a schema, defaulting the action binder to `A`. */
export function eventSchema(
  events: EventDeclaration[],
  options: { maxWindow?: WindowLike; binder?: string; comment?: string } = {},
): EventSchema {
  if (events.length === 0) throw new Error("dogwood: an event schema declares at least one event kind");
  const kinds = new Set<string>();
  for (const e of events) {
    if (kinds.has(e.kind)) throw new Error(`dogwood: event kind "${e.kind}" is declared twice`);
    kinds.add(e.kind);
  }
  return {
    maxWindow: options.maxWindow === undefined ? undefined : window(options.maxWindow),
    binder: assertIdent(options.binder ?? "A", "an action binder"),
    events,
    comment: options.comment,
  };
}

/**
 * The default event-schema shape: `request` (deciding), `response` and `error`,
 * each pinned to the request's principal.
 *
 * This reproduces `configuration/event-schemas/pinned.dwschema`, which is what
 * `ServiceSchema::defaults()` uses. Emitting it explicitly is the honest thing
 * to do the moment a project supplies *any* event schema, because supplying
 * one opts out of the built-in default entirely.
 *
 * @param options.pinCallerPrincipal Drop the pin to allow cross-principal
 * correlation. A deliberate choice: it widens every temporal predicate in the
 * policy set, so it stamps a comment into the emitted file and DWDS010 reports
 * it in the build.
 */
export function defaultEventSchema(
  options: {
    maxWindow?: WindowLike;
    pinCallerPrincipal?: boolean;
    principalField?: string;
    binder?: string;
  } = {},
): EventSchema {
  const pinned = options.pinCallerPrincipal !== false;
  const principalField = options.principalField ?? "callerPrincipal";

  const common = (): EventField[] => [
    pinned
      ? pinnedField(principalField, principalType(), pinPrincipal())
      : field(principalField, principalType()),
    field("callerResource", resourceType()),
    field("requestId", concrete("String")),
    field("sessionId", concrete("String")),
  ];

  return eventSchema(
    [
      eventDeclaration("request", [spreadInputs(), ...common()], { decision: true }),
      eventDeclaration("response", [spreadInputs(), spreadOutputs(), ...common()]),
      eventDeclaration("error", [spreadInputs(), ...common()]),
    ],
    {
      maxWindow: options.maxWindow,
      binder: options.binder,
      comment: pinned
        ? "The default event-schema shape: request/response/error, each correlated to\nthe deciding request's principal."
        : `Cross-principal: ${principalField} is NOT pinned, so temporal predicates see\nevents from every principal, not only the deciding request's. This widens\nevery predicate in the policy set and is a deliberate departure from\nupstream's default (see ServiceSchema::defaults).`,
    },
  );
}

// ── Rendering ─────────────────────────────────────────────────────

function renderPinTarget(target: PinTarget): string {
  return target.ref === "context" ? `context.${target.path.join(".")}` : [target.ref, ...target.attrs].join(".");
}

function renderFieldType(type: EventFieldType, binder: string, indent: string): string {
  switch (type.type) {
    case "selector":
      return `${type.selector}(${binder})`;
    case "concrete":
      return type.name;
    case "record":
      return `{\n${renderFields(type.fields, binder, indent + "    ")}\n${indent}}`;
  }
}

function renderFields(fields: readonly EventField[], binder: string, indent: string): string {
  return fields
    .map((f) => {
      if (f.field === "spread") return `${indent}...${f.selector}(${binder}),`;
      const pin = f.pin ? ` = ${renderPinTarget(f.pin)}` : "";
      return `${indent}${f.pin ? "pin " : ""}${f.name}: ${renderFieldType(f.type, binder, indent)}${pin},`;
    })
    .join("\n");
}

function renderComment(comment: string): string[] {
  return comment.split("\n").map((line) => `// ${line}`.trimEnd());
}

/** Render a schema to `.dwschema` text. */
export function renderEventSchema(schema: EventSchema): string {
  const lines: string[] = [];
  if (schema.comment) lines.push(...renderComment(schema.comment), "");

  if (schema.maxWindow) {
    lines.push(`max_window = ${renderWindow(schema.maxWindow)}`, "");
  }

  for (const [index, event] of schema.events.entries()) {
    if (index > 0) lines.push("");
    if (event.comment) lines.push(...renderComment(event.comment));
    lines.push(`${event.decision ? "decision " : ""}event <${schema.binder}>::${event.kind} {`);
    if (event.fields.length > 0) lines.push(renderFields(event.fields, schema.binder, "    "));
    lines.push("}");
  }

  return lines.join("\n") + "\n";
}

/** Every event kind a schema declares, in declaration order. */
export function declaredEventKinds(schema: EventSchema): string[] {
  return schema.events.map((e) => e.kind);
}
