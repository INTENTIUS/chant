/**
 * Typed builders for dogwood's temporal sub-language.
 *
 * These target the **parser primitives**, not the named aggregates. The #1657
 * verification (and the correction comment on epic #1646) is explicit about
 * why: `formerly`, `previous`, `since`, `exists`, `tp()`, `count for … where`
 * and `sum … for … where` are the only temporal keywords in upstream's
 * `extension/temporal/grammar.pest`. `count_within`, `sum_within`,
 * `count_distinct_within` and `bind` are macros in `default_macros.dw` — a
 * swappable standard library that a caller passing `--macros` replaces
 * wholesale — and `once` is not even in that library, only in the examples.
 *
 * So the aggregates are expressible here as macro *calls* ({@link call}, and
 * the convenience wrappers in `./macros.ts`), never as first-class operators.
 * A call that resolves to nothing at the other end is a missing macro, which
 * is a comprehensible failure; a first-class builder that silently emits a
 * name the callee's library does not define is not.
 *
 * Everything below renders to the surface syntax the pest grammar accepts.
 * Where the grammar's precedence would bind differently from the tree the
 * author built, the renderer parenthesises — it never relies on the reader
 * knowing that `!` binds tighter than `since`, or that an aggregate's `where`
 * body is greedy.
 */

import { escapeCedarString } from "../policy-text";
import {
  renderWindow,
  renderWindowValue,
  window,
  windowValue,
  type TemporalWindow,
  type WindowLike,
  type WindowParam,
  type WindowValue,
} from "./window";

/** What the three past-only operators accept: a window, or a macro's `?w`. */
export type WindowArgument = WindowLike | WindowParam;

// ── Names ─────────────────────────────────────────────────────────

/** A bare binder or field name. */
const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;
/** `?p` (call-site value splice) or `$t` (macro-introduced fresh binder). */
const SIGIL = /^[?$][A-Za-z_][A-Za-z0-9_]*$/;
/** `input.user`, `output.result` — the dotted path a predicate argument names. */
const FIELD_PATH = /^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)*$/;
/** `Drupe::Action::"Read"` — a qualified action with a quoted id. */
const QUALIFIED_ACTION = /^[A-Za-z_][A-Za-z0-9_]*(::[A-Za-z_][A-Za-z0-9_]*)*::"[^"]*"$/;
/** `String`, `Long`, `Timepoint`, `MyApp::OAuthUser`. */
const TYPE_NAME = /^[A-Za-z_][A-Za-z0-9_]*(::[A-Za-z_][A-Za-z0-9_]*)*$/;

function assertName(pattern: RegExp, value: string, what: string): string {
  if (!pattern.test(value)) throw new Error(`dogwood: ${what} — got "${value}"`);
  return value;
}

/**
 * A binder position: a plain identifier, or a macro sigil.
 *
 * The sigils are legal only inside a macro body; upstream's well-formedness
 * pass rejects them elsewhere. `./macros.ts` is where they belong, and it is
 * what carries that warning to the author.
 */
export function binderName(value: string): string {
  if (IDENT.test(value) || SIGIL.test(value)) return value;
  throw new Error(
    `dogwood: a binder must be an identifier, or a "?param"/"$binder" sigil inside a macro body — got "${value}"`,
  );
}

// ── Terms ─────────────────────────────────────────────────────────

/** `(x: T)` — a declaration site in an `exists` or a `for` list. */
export interface TypedBinder {
  readonly name: string;
  readonly type: string;
}

/** `(t: Timepoint)`, `(amount: Long)`, `($t: Timepoint)` inside a macro. */
export function typedBinder(name: string, type: string): TypedBinder {
  return { name: binderName(name), type: assertName(TYPE_NAME, type, "a binder type must be a Cedar type name") };
}

/** Anything that renders in term position. */
export type TemporalTerm = TermText | ArrayTerm | CountTerm | SumTerm | CallNode;

/** A leaf term already in its surface form (a literal, a path, an entity UID). */
export interface TermText {
  readonly op: "term";
  readonly text: string;
}

/** `[a, b, c]`. */
export interface ArrayTerm {
  readonly op: "array";
  readonly items: readonly TemporalTerm[];
}

/** `count for (t: Timepoint). where φ`. */
export interface CountTerm {
  readonly op: "count";
  readonly binders: readonly TypedBinder[];
  readonly where: TemporalCondition;
}

/** `sum a for (a: Long), (t: Timepoint). where φ`. */
export interface SumTerm {
  readonly op: "sum";
  readonly over: string;
  readonly binders: readonly TypedBinder[];
  readonly where: TemporalCondition;
}

/**
 * What a builder accepts in term position.
 *
 * Numbers and booleans lift to literals because there is only one thing they
 * can mean. A bare `string` deliberately does not: `"alice"` is a Cedar string
 * literal and `alice` is a binder reference, and guessing which one the author
 * meant is how a policy silently stops matching. Say which with {@link str},
 * {@link varRef}, {@link ctx} or {@link entityUid}.
 */
export type TermInput = TemporalTerm | number | boolean;

function liftTerm(value: TermInput): TemporalTerm {
  if (typeof value === "number") return int(value);
  if (typeof value === "boolean") return bool(value);
  return value;
}

/** A raw term, emitted verbatim. The escape hatch for a shape not modelled here. */
export function term(text: string): TermText {
  return { op: "term", text };
}

/** A Cedar string literal: `"alice"`. */
export function str(value: string): TermText {
  return term(`"${escapeCedarString(value)}"`);
}

/** An integer literal. Upstream's grammar admits a leading `-`. */
export function int(value: number): TermText {
  if (!Number.isInteger(value)) {
    throw new Error(`dogwood: an integer term must be a whole number — use decimalOf() for ${value}`);
  }
  return term(String(value));
}

/** `true` / `false`. */
export function bool(value: boolean): TermText {
  return term(value ? "true" : "false");
}

/** `decimal("1.50")` — Cedar's decimal constructor, which dogwood admits as a term. */
export function decimalOf(value: string): TermText {
  return term(`decimal("${escapeCedarString(value)}")`);
}

/** `context.input.user` — a field of the request context record. */
export function ctx(path: string): TermText {
  assertName(FIELD_PATH, path, "a context path must be dotted identifiers");
  return term(`context.${path}`);
}

/** `principal`, `resource`, `principal.dept` — the request scope entities. */
export function scopeRef(root: "principal" | "resource", ...attrs: string[]): TermText {
  for (const attr of attrs) assertName(IDENT, attr, "a scope attribute must be an identifier");
  return term([root, ...attrs].join("."));
}

/** `Drupe::OAuthUser::"alice"` — an entity UID literal. */
export function entityUid(uid: string): TermText {
  assertName(QUALIFIED_ACTION, uid, 'an entity UID looks like Ns::Type::"id"');
  return term(uid);
}

/** A bare binder reference — a `for`-declared variable, or a macro sigil. */
export function varRef(name: string): TermText {
  return term(binderName(name));
}

/** `*` — the grammar's wildcard term. */
export function wildcard(): TermText {
  return term("*");
}

/** `[a, b]`. */
export function arrayOf(...items: TermInput[]): ArrayTerm {
  return { op: "array", items: items.map(liftTerm) };
}

/**
 * `count for (t: Timepoint). where φ` — the primitive behind `count_within`.
 *
 * The `for` list is the aggregation domain and is mandatory in the grammar,
 * so it is a required argument here too.
 */
export function count(binders: TypedBinder[], where: TemporalCondition): CountTerm {
  if (binders.length === 0) throw new Error("dogwood: count needs at least one typed binder in its for-list");
  return { op: "count", binders, where };
}

/** `sum a for (a: Long), (t: Timepoint). where φ` — the primitive behind `sum_within`. */
export function sum(over: string, binders: TypedBinder[], where: TemporalCondition): SumTerm {
  if (binders.length === 0) throw new Error("dogwood: sum needs at least one typed binder in its for-list");
  return { op: "sum", over: binderName(over), binders, where };
}

// ── Conditions ────────────────────────────────────────────────────

/** Anything that renders in condition position. */
export type TemporalCondition =
  | PredicateNode
  | FormerlyNode
  | PreviousNode
  | SinceNode
  | ExistsNode
  | TpNode
  | AndNode
  | NotNode
  | ComparisonNode
  | CallNode
  | SigilCondition
  | RawCondition;

/** `Drupe::Action::"Login"::response{ input.user: context.input.user }`. */
export interface PredicateNode {
  readonly op: "predicate";
  readonly action: string;
  readonly kind: string;
  readonly args: ReadonlyArray<{ readonly path: string; readonly value: TemporalTerm }>;
}

/** `formerly within 1h φ`. */
export interface FormerlyNode {
  readonly op: "formerly";
  readonly window: WindowValue;
  readonly body: TemporalCondition;
}

/** `previous within 30s φ`. */
export interface PreviousNode {
  readonly op: "previous";
  readonly window: WindowValue;
  readonly body: TemporalCondition;
}

/** `φ since within 1h ψ` — infix, with the window on the operator. */
export interface SinceNode {
  readonly op: "since";
  readonly left: TemporalCondition;
  readonly window: WindowValue;
  readonly right: TemporalCondition;
}

/** `exists (total: Long). φ`. */
export interface ExistsNode {
  readonly op: "exists";
  readonly binder: TypedBinder;
  readonly body: TemporalCondition;
}

/** `tp(t)` — binds the timepoint under evaluation. */
export interface TpNode {
  readonly op: "tp";
  readonly binder: string;
}

/** `φ && ψ`. */
export interface AndNode {
  readonly op: "and";
  readonly operands: readonly TemporalCondition[];
}

/** `!φ`. */
export interface NotNode {
  readonly op: "not";
  readonly body: TemporalCondition;
}

/** `a == b`, `0 < count …`. */
export interface ComparisonNode {
  readonly op: "compare";
  readonly left: TemporalTerm;
  readonly operator: ComparisonOperator;
  readonly right: TemporalTerm;
}

/** The six operators `cmp_op` admits. */
export type ComparisonOperator = "==" | "!=" | "<" | "<=" | ">" | ">=";

/** A macro invocation — `once(1h, φ)`. Legal in both condition and term position. */
export interface CallNode {
  readonly op: "call";
  readonly name: string;
  readonly args: readonly MacroArg[];
}

/** `1h` as a macro-call argument — bare, with no `within` keyword. */
export interface IntervalArg {
  readonly op: "interval";
  readonly window: TemporalWindow;
}

/** What a macro call takes: an interval, a condition, or a term. */
export type MacroArg = IntervalArg | TemporalCondition | TemporalTerm;

/**
 * Temporal source text emitted verbatim.
 *
 * The one builder that can produce something the walls exist to catch — a
 * `formerly` with no window, an event kind the schema never declared. That is
 * deliberate: an escape hatch nobody can reach makes the walls untestable, and
 * DWDC012 reads the serialized text precisely because this exists.
 */
export interface RawCondition {
  readonly op: "raw";
  readonly text: string;
}

/**
 * `?s` — a macro parameter standing for an entire condition.
 *
 * Its own node rather than a {@link RawCondition} because the grammar treats
 * it as an atom (`refinable = (predicate | sigil_cond) ~ field_block*`), so
 * `formerly within ?w ?s` needs no parentheses where arbitrary raw text would.
 * Build one with `macroCondition()` in `./macros.ts`, which is where the rule
 * that sigils are legal only inside a macro body is documented.
 */
export interface SigilCondition {
  readonly op: "sigil";
  readonly param: string;
}

// ── Condition builders ────────────────────────────────────────────

/**
 * `Ns::Action::"Name"::kind{ field: term, … }`.
 *
 * The event kind is mandatory in the grammar and author-defined in practice —
 * `request`/`response`/`error` are the conventional kinds the default event
 * schema declares, not a fixed set. Which kinds are legal for a given policy
 * set is the emitted `.dwschema`'s business, and DWDC010's.
 */
export function predicate(
  action: string,
  kind: string,
  args: Record<string, TermInput> = {},
): PredicateNode {
  assertName(QUALIFIED_ACTION, action, 'a predicate action looks like Ns::Action::"Name"');
  assertName(IDENT, kind, "an event kind must be an identifier");
  return {
    op: "predicate",
    action,
    kind,
    args: Object.entries(args).map(([path, value]) => ({
      path: assertName(FIELD_PATH, path, "a predicate field path must be dotted identifiers"),
      value: liftTerm(value),
    })),
  };
}

/** `formerly within <w> φ` — held at some point in the window. */
export function formerly(w: WindowArgument, body: TemporalCondition): FormerlyNode {
  return { op: "formerly", window: windowValue(w), body };
}

/** `previous within <w> φ` — held at the immediately preceding timepoint in the window. */
export function previous(w: WindowArgument, body: TemporalCondition): PreviousNode {
  return { op: "previous", window: windowValue(w), body };
}

/** `φ since within <w> ψ` — φ has held continuously since ψ, inside the window. */
export function since(left: TemporalCondition, w: WindowArgument, right: TemporalCondition): SinceNode {
  return { op: "since", left, window: windowValue(w), right };
}

/** `exists (name: Type). φ`. */
export function exists(binder: TypedBinder, body: TemporalCondition): ExistsNode {
  return { op: "exists", binder, body };
}

/** `tp(t)`. */
export function tp(binder: string): TpNode {
  return { op: "tp", binder: binderName(binder) };
}

/** `φ && ψ && …`. A single operand collapses to itself. */
export function and(...operands: TemporalCondition[]): TemporalCondition {
  if (operands.length === 0) throw new Error("dogwood: and() needs at least one operand");
  if (operands.length === 1) return operands[0];
  return { op: "and", operands };
}

/** `!φ`. */
export function not(body: TemporalCondition): NotNode {
  return { op: "not", body };
}

/** `a <op> b`. */
export function compare(left: TermInput, operator: ComparisonOperator, right: TermInput): ComparisonNode {
  return { op: "compare", left: liftTerm(left), operator, right: liftTerm(right) };
}

/**
 * A macro invocation.
 *
 * Nothing here checks that the macro exists: the library is `--macros`, chosen
 * by whoever runs `dogwood validate`, and chant is not that. `./macros.ts`
 * carries typed wrappers for the four the default library ships.
 */
export function call(name: string, args: MacroArg[] = []): CallNode {
  assertName(IDENT, name, "a macro name must be an identifier");
  return { op: "call", name, args };
}

/** `1h` in macro-call argument position — the interval without the `within`. */
export function interval(w: WindowLike): IntervalArg {
  return { op: "interval", window: window(w) };
}

/** Temporal source text, passed through untouched. See {@link RawCondition}. */
export function raw(text: string): RawCondition {
  return { op: "raw", text };
}

/** `?s` in condition position. See {@link SigilCondition}. */
export function sigilCondition(param: string): SigilCondition {
  if (!SIGIL.test(param)) throw new Error(`dogwood: a condition sigil looks like "?s" — got "${param}"`);
  return { op: "sigil", param };
}

// ── Rendering ─────────────────────────────────────────────────────

function isTerm(node: MacroArg): node is TemporalTerm {
  return node.op === "term" || node.op === "array" || node.op === "count" || node.op === "sum";
}

function isAggregate(t: TemporalTerm): boolean {
  return t.op === "count" || t.op === "sum";
}

/** Render a term. */
export function renderTerm(t: TemporalTerm): string {
  switch (t.op) {
    case "term":
      return t.text;
    case "array":
      return `[${t.items.map(renderTerm).join(", ")}]`;
    case "count":
      return `count ${renderForBinders(t.binders)} where ${renderCondition(t.where)}`;
    case "sum":
      return `sum ${t.over} ${renderForBinders(t.binders)} where ${renderCondition(t.where)}`;
    case "call":
      return renderCall(t);
  }
}

function renderForBinders(binders: readonly TypedBinder[]): string {
  return `for ${binders.map((b) => `(${b.name}: ${b.type})`).join(", ")}.`;
}

/**
 * A comparison operand.
 *
 * An aggregate's `where` body is greedy, so `count for (…). where φ == 3`
 * reads `== 3` as part of φ. Upstream's `paren_agg` rule exists for exactly
 * this and is always legal, so aggregates and macro calls are parenthesised on
 * both sides rather than only where the greed would actually bite — the
 * emitted text should not depend on which side of the operator it landed on.
 */
function renderComparisonOperand(t: TemporalTerm): string {
  return isAggregate(t) || t.op === "call" ? `(${renderTerm(t)})` : renderTerm(t);
}

function renderCall(node: CallNode): string {
  const args = node.args.map((arg) => {
    if (arg.op === "interval") return renderWindow(arg.window);
    if (isTerm(arg)) return renderTerm(arg);
    return renderCondition(arg);
  });
  return `${node.name}(${args.join(", ")})`;
}

/**
 * An `atom` — the operand of `formerly`, `previous` and the right of `since`.
 *
 * The grammar's `atom` is `"(" condition ")" | tp_op | call | refinable |
 * comparison`; everything else has to be parenthesised.
 */
function renderAtom(node: TemporalCondition): string {
  switch (node.op) {
    case "predicate":
    case "sigil":
    case "tp":
    case "call":
    case "compare":
      return renderCondition(node);
    default:
      return `(${renderCondition(node)})`;
  }
}

/**
 * A `neg_conjunct` — what `!` negates, and what sits left of `since`.
 *
 * `!` binds tighter than `since` and `&&`, so `!a since within W b` negates
 * only `a`. Anything looser gets parentheses.
 */
function renderNegConjunct(node: TemporalCondition): string {
  switch (node.op) {
    case "and":
    case "since":
    case "exists":
      return `(${renderCondition(node)})`;
    default:
      return renderCondition(node);
  }
}

/**
 * A `conjunct_or_since` — one operand of an `&&` chain.
 *
 * `since` is allowed here bare (it is part of the same rule). `exists` binds
 * maximally to the right, so an unparenthesised one would swallow every
 * operand after it.
 */
function renderConjunct(node: TemporalCondition): string {
  switch (node.op) {
    case "and":
    case "exists":
      return `(${renderCondition(node)})`;
    default:
      return renderCondition(node);
  }
}

/** Render a temporal condition to the surface syntax the pest grammar accepts. */
export function renderCondition(node: TemporalCondition): string {
  switch (node.op) {
    case "raw":
      return node.text;

    case "sigil":
      return node.param;

    case "predicate": {
      const args = node.args.map((a) => `${a.path}: ${renderTerm(a.value)}`).join(", ");
      return `${node.action}::${node.kind}{${args.length > 0 ? ` ${args} ` : ""}}`;
    }

    case "formerly":
      return `formerly within ${renderWindowValue(node.window)} ${renderAtom(node.body)}`;

    case "previous":
      return `previous within ${renderWindowValue(node.window)} ${renderAtom(node.body)}`;

    case "since":
      return `${renderNegConjunct(node.left)} since within ${renderWindowValue(node.window)} ${renderAtom(node.right)}`;

    case "exists":
      return `exists (${node.binder.name}: ${node.binder.type}). ${renderCondition(node.body)}`;

    case "tp":
      return `tp(${node.binder})`;

    case "and":
      return node.operands.map(renderConjunct).join(" && ");

    case "not":
      return `!${renderNegConjunct(node.body)}`;

    case "compare":
      return `${renderComparisonOperand(node.left)} ${node.operator} ${renderComparisonOperand(node.right)}`;

    case "call":
      return renderCall(node);
  }
}

/**
 * `temporal { … }` — the extension marker.
 *
 * It is a `primary` in the Cedar expression grammar as well as a clause tag,
 * so this is also how a temporal condition is embedded mid-expression:
 * `when { is_small(context.input.shares) && temporal { once(1h, …) } }`.
 */
export function temporalMarker(condition: TemporalCondition): string {
  return `temporal { ${renderCondition(condition)} }`;
}
