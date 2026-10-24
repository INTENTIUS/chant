/**
 * Normalization: a Postgres object's definition in a form two definitions can
 * be compared in, so a declaration and what the catalog prints for it are
 * equal when they mean the same thing (#3279, #3275 question 6).
 *
 * The catalog's printers rewrite what they were given. `format_type()` spells
 * every type its SQL way (`timestamptz` is `timestamp with time zone`,
 * `int4` is `integer`, `numeric(12, 2)` is `numeric(12,2)`); `pg_get_expr()`
 * casts every literal (`'placed'::app.order_status`, `0::numeric`, a negative
 * number as `'-1'::integer`), rewrites `x IN ('a', 'b')` as
 * `x = ANY (ARRAY['a'::text, 'b'::text])` and parenthesizes a check;
 * `pg_get_constraintdef()` names every constraint; `pg_get_indexdef()` adds
 * `USING btree`; with an empty `search_path` every name outside `pg_catalog`
 * is schema-qualified. Each of those is undone here, on both sides, by rule:
 *
 * - an expression compares as its token sequence: whitespace and comments
 *   left out, unquoted words in lower case, a quoted name that needs no quotes
 *   written bare, a cast on a literal dropped, a quoted number cast to a
 *   number read as the number, `IN (literals)` read as `= ANY (ARRAY[...])`,
 *   and parentheses around the whole of it dropped;
 * - a type is its `format_type()` spelling, from the pinned catalog's alias
 *   table; a type outside `pg_catalog` is qualified with the default schema;
 * - a name with no schema is in the default schema (`public` unless the
 *   profile says otherwise), as `search_path` would resolve it;
 * - a constraint the declaration leaves unnamed is matched by what it says,
 *   not by the name Postgres gave it; a primary key's and an identity
 *   column's columns are `NOT NULL` whether or not that is written;
 * - an identity column's or a sequence's options at their defaults are left
 *   out; storage parameters compare as a map;
 * - an index's access method defaults to `btree`;
 * - a function's or procedure's parameter types drop their modifiers (the
 *   catalog keeps none: `varchar(20)` is `character varying`), a parameter's
 *   mode is `in` unless written, its attributes at their defaults (VOLATILE,
 *   CALLED ON NULL INPUT, SECURITY INVOKER, PARALLEL UNSAFE, COST 100 or 1,
 *   ROWS 1000 or 0) are left out, and its body is compared as written, since
 *   the server keeps it verbatim;
 * - a trigger's events compare as a set, `UPDATE OF` columns sorted, and its
 *   arguments as the strings the catalog stores.
 *
 * What the rules cannot see (a view's `SELECT *`, which the server expands, or
 * an expression it parenthesizes) is asked of the live server itself when a
 * plan or a deep read has one (`./server-normalize.ts`). Offline, between two
 * builds, only the rules apply.
 */

import { isTrivia, tokenizeText, type Token } from "../tokens";
import { identValue } from "../parser";
import { quoteIdent } from "../keywords";
import { COLUMN_TYPES, FUNCTIONS } from "../../generated/postgres";
import { stripMarker } from "../../core/ownership";
import { sequenceDefaults } from "../live/catalog";
import type {
  AggregateArgDef,
  OperatorProps,
  OperatorClassProps,
  OperatorFamilyProps,
  ForeignTableProps,
  TextSearchConfigurationProps,
  TextSearchDictionaryProps,
  AggregateProps,
  CastProps,
  CheckDef,
  CollationProps,
  ColumnDef,
  CompositeTypeProps,
  DomainProps,
  EventTriggerProps,
  StatisticsProps,
  ForeignDataWrapperProps,
  ForeignServerProps,
  PublicationProps,
  RangeTypeProps,
  EnumProps,
  ExclusionDef,
  ExtensionProps,
  ForeignKeyDef,
  IndexProps,
  KeyDef,
  SchemaProps,
  DefaultPrivilegesProps,
  GrantProps,
  PolicyProps,
  RoleProps,
  RoutineProps,
  SequenceProps,
  TableProps,
  TriggerProps,
  ViewProps,
} from "../entities";
import { stringValue } from "../entities";
import { parseStatements } from "../parser";
import type { RoutineNode } from "../parser";

// ── Types ──────────────────────────────────────────────────────────────

/** Every spelling of a built-in type, to its `format_type()` spelling. */
const TYPE_SPELLING: ReadonlyMap<string, string> = (() => {
  const m = new Map<string, string>();
  for (const [sql, spec] of Object.entries(COLUMN_TYPES) as Array<[string, { aliases: readonly string[]; catalogName?: string }]>) {
    m.set(sql, sql);
    for (const a of spec.aliases) m.set(a, sql);
    if (spec.catalogName) m.set(spec.catalogName, sql);
  }
  // Spellings the parser accepts that the catalog does not list.
  for (const [a, sql] of [
    ["int", "integer"],
    ["float", "double precision"],
    ["decimal", "numeric"],
    ["dec", "numeric"],
    ["char", "character"],
    ["timestamp without time zone", "timestamp without time zone"],
    ["time without time zone", "time without time zone"],
  ] as const) {
    if (!m.has(a)) m.set(a, sql);
  }
  return m;
})();

/**
 * `serial`, `bigserial` and `smallserial` are not types in the catalog: each
 * is shorthand for an integer column with an owned sequence and a `nextval`
 * default, so they are never schema-qualified. The live read prints such a
 * column as the shorthand; `serialBase` gives the integer type underneath.
 */
const SERIAL_BASE: Readonly<Record<string, string>> = { serial: "integer", bigserial: "bigint", smallserial: "smallint" };

/** The integer type a serial spelling stands for, or undefined for any other type. */
export const serialBase = (type: string | undefined): string | undefined => (type === undefined ? undefined : SERIAL_BASE[type]);

/** A qualified name in canonical form: each piece unquoted where it can be, the default schema added to a bare one. */
export function canonicalName(text: string, defaultSchema?: string): string {
  const pieces = text
    .split(/\.(?=(?:[^"]*"[^"]*")*[^"]*$)/)
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => quoteIdent(identValue(p)));
  if (pieces.length === 1 && defaultSchema !== undefined) pieces.unshift(quoteIdent(defaultSchema));
  return pieces.join(".");
}

/**
 * A type as `format_type()` prints it: `int4` and `int` are `integer`,
 * `timestamptz` is `timestamp with time zone`, `varchar(20)` is
 * `character varying(20)`, `int[]` is `integer[]`, `numeric(12, 2)` is
 * `numeric(12,2)`, a type outside `pg_catalog` is schema-qualified.
 */
export function canonicalType(text: string | undefined, defaultSchema = "public"): string | undefined {
  if (text === undefined) return undefined;
  const t = text.trim();
  // Array bounds: `int[3]`, `int ARRAY[3]`, `int ARRAY` are all `integer[]`.
  const arrayMatch = /^(.*?)(\s*(\[\s*\d*\s*\]|\s+array(\s*\[\s*\d*\s*\])?)\s*)+$/i.exec(t);
  const base = arrayMatch ? arrayMatch[1]!.trim() : t;
  const dims = arrayMatch ? Math.max(1, (t.slice(arrayMatch[1]!.length).match(/\[/g) ?? []).length) : 0;
  const m = /^(.*?)\s*(\(([^()]*)\))?\s*((with|without)\s+time\s+zone)?$/i.exec(base)!;
  let name = m[1]!.trim().replace(/\s+/g, " ");
  const modifiers = m[3] !== undefined ? `(${m[3]!.split(",").map((x) => x.trim()).join(",")})` : "";
  const zone = m[4] ? ` ${m[4]!.toLowerCase().replace(/\s+/g, " ")}` : "";
  const lower = /"/.test(name) ? name : name.toLowerCase();
  let spelled: string;
  const builtin = TYPE_SPELLING.get(`${lower}${zone}`) ?? TYPE_SPELLING.get(lower);
  if (SERIAL_BASE[lower] !== undefined && modifiers === "" && !zone) {
    spelled = lower;
  } else if (builtin !== undefined) {
    spelled = builtin;
    // `timestamp(3) with time zone`: the modifier sits before the zone.
    if (modifiers && /^(timestamp|time) with(out)? time zone$/.test(spelled)) {
      spelled = spelled.replace(/^(timestamp|time)/, `$1${modifiers}`);
      return spelled + "[]".repeat(dims);
    }
    if (zone && !TYPE_SPELLING.has(`${lower}${zone}`)) spelled += zone;
  } else if (/^(timestamp|time)$/.test(lower)) {
    spelled = `${lower} without time zone`;
    if (modifiers) return `${lower}${modifiers} without time zone${"[]".repeat(dims)}`;
  } else {
    name = canonicalName(name, defaultSchema);
    spelled = name.startsWith("pg_catalog.") ? name.slice("pg_catalog.".length) : name;
  }
  return `${spelled}${modifiers}${"[]".repeat(dims)}`;
}

// ── Expressions ────────────────────────────────────────────────────────

const NUMERIC_TYPES = new Set(["smallint", "integer", "bigint", "numeric", "real", "double precision", "int2", "int4", "int8", "float4", "float8", "decimal"]);

/** The tokens of a cast's type after `::`, from index `i`; returns the index after it and the type's text. */
function castEnd(sig: readonly Token[], i: number): { end: number; type: string } {
  let j = i;
  const words: string[] = [];
  const word = (t: Token | undefined) => t !== undefined && (t.kind === "ident" || t.kind === "qident");
  if (!word(sig[j])) return { end: i, type: "" };
  words.push(sig[j]!.text);
  j++;
  while (sig[j]?.kind === "punct" && sig[j]!.text === "." && word(sig[j + 1])) {
    words.push(".", sig[j + 1]!.text);
    j += 2;
  }
  while (sig[j]?.kind === "ident" && /^(varying|precision|with|without|time|zone)$/i.test(sig[j]!.text)) {
    words.push(" ", sig[j]!.text);
    j++;
  }
  if (sig[j]?.kind === "punct" && sig[j]!.text === "(") {
    let depth = 0;
    for (; j < sig.length; j++) {
      if (sig[j]!.text === "(") depth++;
      if (sig[j]!.text === ")" && --depth === 0) {
        j++;
        break;
      }
    }
  }
  while (sig[j]?.kind === "punct" && sig[j]!.text === "[" && sig[j + 1]?.text === "]") j += 2;
  return { end: j, type: words.join("").toLowerCase() };
}

const isLiteral = (t: Token | undefined): boolean => t !== undefined && (t.kind === "string" || t.kind === "number" || (t.kind === "ident" && t.text.toUpperCase() === "NULL"));

/** One token's canonical text. */
function tokenText(t: Token): string {
  if (t.kind === "ident") return t.text.toLowerCase();
  if (t.kind === "qident") return quoteIdent(identValue(t));
  if (t.kind === "string" && /^[Ee]'/.test(t.text) && !t.text.includes("\\")) return t.text.slice(1);
  return t.text;
}

/**
 * An expression in canonical form: a string of tokens joined by single
 * spaces. Two expressions that read the same after the rules in this file's
 * header have the same canonical form.
 */
export function canonicalExpr(text: string | undefined): string | undefined {
  if (text === undefined) return undefined;
  let tokens: Token[];
  try {
    tokens = tokenizeText(text, 0).filter((t) => !isTrivia(t));
  } catch {
    return text.trim().replace(/\s+/g, " ");
  }
  const out: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!;
    // A cast on a literal: `'placed'::app.order_status` is `'placed'`, `'-1'::integer` is `-1`.
    if (isLiteral(t) && tokens[i + 1]?.kind === "op" && tokens[i + 1]!.text === "::") {
      const { end, type } = castEnd(tokens, i + 2);
      if (end > i + 2) {
        const numeric = /^'(-?\d+(\.\d+)?)'$/.exec(t.text);
        if (numeric && NUMERIC_TYPES.has(type)) out.push(...(numeric[1]!.startsWith("-") ? ["-", numeric[1]!.slice(1)] : [numeric[1]!]));
        else out.push(tokenText(t));
        i = end - 1;
        continue;
      }
    }
    out.push(tokenText(t));
  }
  return rewriteIn(dropOuterParens(out)).join(" ");
}

/** Parentheses around the whole expression, repeatedly. */
function dropOuterParens(tokens: string[]): string[] {
  let t = tokens;
  while (t.length >= 2 && t[0] === "(" && t[t.length - 1] === ")") {
    let depth = 0;
    let wraps = true;
    for (let i = 0; i < t.length; i++) {
      if (t[i] === "(") depth++;
      if (t[i] === ")") depth--;
      if (depth === 0 && i < t.length - 1) {
        wraps = false;
        break;
      }
    }
    if (!wraps) break;
    t = t.slice(1, -1);
  }
  return t;
}

/** `x IN (a, b)` as `x = ANY (ARRAY[a, b])` and `x NOT IN (a, b)` as `x <> ALL (ARRAY[a, b])`, for a list of literals. */
function rewriteIn(tokens: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const negated = tokens[i] === "not" && tokens[i + 1] === "in";
    const at = negated ? i + 1 : i;
    if (tokens[at] === "in" && tokens[at + 1] === "(") {
      let j = at + 2;
      const items: string[] = [];
      let ok = true;
      for (; j < tokens.length && tokens[j] !== ")"; j++) {
        if (tokens[j] === ",") continue;
        if (!/^('.*'|-?\d+(\.\d+)?)$/s.test(tokens[j]!)) {
          ok = false;
          break;
        }
        items.push(tokens[j]!);
      }
      if (ok && tokens[j] === ")" && items.length > 0) {
        out.push(negated ? "<>" : "=", negated ? "all" : "any", "(", "array", "[", ...items.flatMap((x, k) => (k === 0 ? [x] : [",", x])), "]", ")");
        i = j;
        continue;
      }
    }
    out.push(tokens[i]!);
  }
  return out;
}

/** A storage parameter list as a sorted map: `(fillfactor = 70)` and `WITH (fillfactor=70)` are `{ fillfactor: "70" }`. */
export function canonicalOptions(text: string | undefined): Record<string, string> | undefined {
  if (text === undefined) return undefined;
  const inner = text.trim().replace(/^\(/, "").replace(/\)$/, "");
  const out: Record<string, string> = {};
  for (const item of inner.split(",").map((s) => s.trim()).filter(Boolean)) {
    const [k, v] = item.split("=").map((s) => s.trim()) as [string, string | undefined];
    out[k.toLowerCase()] = (v ?? "true").replace(/^'(.*)'$/, "$1").toLowerCase();
  }
  return Object.keys(out).length ? Object.fromEntries(Object.entries(out).sort(([a], [b]) => (a < b ? -1 : 1))) : undefined;
}

// ── Objects ────────────────────────────────────────────────────────────

export interface CanonicalColumn {
  name: string;
  position: number;
  type?: string;
  notNull: boolean;
  default?: string;
  generated?: string;
  identity?: string;
  collate?: string;
  compression?: string;
  storage?: string;
  /** A foreign table column's `OPTIONS`, sorted by name. */
  options?: Record<string, string>;
  comment?: string;
}

export interface CanonicalConstraint {
  kind: "PRIMARY KEY" | "UNIQUE" | "CHECK" | "FOREIGN KEY" | "EXCLUDE";
  /** The declared name; undefined when the declaration gave none, so a generated name is not compared. */
  name?: string;
  /** What the constraint says, names left out: two with the same body are the same constraint. */
  body: string;
  /** Whether the constraint is `NOT VALID`: a validation step, not part of what it says. */
  notValid?: boolean;
  comment?: string;
}

export type CanonicalKind =
  | "schema"
  | "table"
  | "index"
  | "view"
  | "materializedView"
  | "sequence"
  | "enum"
  | "composite"
  | "range"
  | "domain"
  | "extension"
  | "aggregate"
  | "collation"
  | "cast"
  | "eventTrigger"
  | "operator"
  | "operatorClass"
  | "operatorFamily"
  | "foreignTable"
  | "textSearchConfiguration"
  | "textSearchDictionary"
  | "statistics"
  | "foreignDataWrapper"
  | "foreignServer"
  | "publication"
  | "function"
  | "procedure"
  | "trigger"
  | "policy"
  | "role"
  | "grant"
  | "defaultPrivileges";

/** The kinds whose declarations are privileges, compared as the access they add up to (`../access/`), not one by one. */
export const ACCESS_KINDS: ReadonlySet<CanonicalKind> = new Set(["grant", "defaultPrivileges"]);

/** The kinds a profile manages only when it says so (`sql.profiles.<env>.access`). */
export const ACCESS_MANAGED_KINDS: ReadonlySet<CanonicalKind> = new Set(["policy", "role", "grant", "defaultPrivileges"]);

export interface CanonicalPgObject {
  kind: CanonicalKind;
  schema?: string;
  name: string;
  /**
   * What tells the object from another of the same name: a routine's input
   * parameter types, `(integer,text)`; a trigger's table, ` ON app.users`.
   * Written as SQL names the object after its name.
   */
  signature?: string;
  /** Everything else that is compared, by field, each field canonical. */
  fields: Record<string, unknown>;
  columns: CanonicalColumn[];
  constraints: CanonicalConstraint[];
}

const kindOf: Record<string, CanonicalKind> = {
  "Postgres::Schema": "schema",
  "Postgres::Table": "table",
  "Postgres::Index": "index",
  "Postgres::View": "view",
  "Postgres::MaterializedView": "materializedView",
  "Postgres::Sequence": "sequence",
  "Postgres::Enum": "enum",
  "Postgres::CompositeType": "composite",
  "Postgres::RangeType": "range",
  "Postgres::Domain": "domain",
  "Postgres::Aggregate": "aggregate",
  "Postgres::Collation": "collation",
  "Postgres::Cast": "cast",
  "Postgres::EventTrigger": "eventTrigger",
  "Postgres::Operator": "operator",
  "Postgres::OperatorClass": "operatorClass",
  "Postgres::OperatorFamily": "operatorFamily",
  "Postgres::ForeignTable": "foreignTable",
  "Postgres::TextSearchConfiguration": "textSearchConfiguration",
  "Postgres::TextSearchDictionary": "textSearchDictionary",
  "Postgres::Statistics": "statistics",
  "Postgres::ForeignDataWrapper": "foreignDataWrapper",
  "Postgres::ForeignServer": "foreignServer",
  "Postgres::Publication": "publication",
  "Postgres::Extension": "extension",
  "Postgres::Function": "function",
  "Postgres::Procedure": "procedure",
  "Postgres::Trigger": "trigger",
  "Postgres::Policy": "policy",
  "Postgres::Role": "role",
  "Postgres::Grant": "grant",
  "Postgres::DefaultPrivileges": "defaultPrivileges",
};

const comment = (c: string | undefined): string | undefined => {
  if (c === undefined) return undefined;
  const own = stripMarker(c);
  return own === "" ? undefined : own;
};

const refTableOf = (fk: ForeignKeyDef, defaultSchema: string): string => canonicalName(fk.refTable, defaultSchema);

/** Identity or sequence options, at their defaults left out, as a sorted `key value` list. */
export function canonicalSequenceOptions(
  o: { type?: string; increment?: string; minValue?: string | null; maxValue?: string | null; start?: string; cache?: string; cycle?: boolean },
  ownerType?: string,
): string {
  const type = canonicalType(o.type ?? ownerType ?? "bigint")!;
  const inc = BigInt((o.increment ?? "1").replace(/\s+/g, ""));
  const d = sequenceDefaults(type, inc);
  const min = o.minValue === null || o.minValue === undefined ? d.min : o.minValue.replace(/\s+/g, "");
  const max = o.maxValue === null || o.maxValue === undefined ? d.max : o.maxValue.replace(/\s+/g, "");
  const start = o.start === undefined ? (inc > 0n ? min : max) : o.start.replace(/\s+/g, "");
  const out = [
    ...(o.type !== undefined && type !== (ownerType ? canonicalType(ownerType) : "bigint") ? [`type ${type}`] : []),
    ...(inc !== 1n ? [`increment ${inc}`] : []),
    ...(min !== d.min ? [`min ${min}`] : []),
    ...(max !== d.max ? [`max ${max}`] : []),
    ...(start !== (inc > 0n ? min : max) ? [`start ${start}`] : []),
    ...((o.cache ?? "1") !== "1" ? [`cache ${o.cache}`] : []),
    ...(o.cycle ? ["cycle"] : []),
  ];
  return out.join(", ");
}

/** An identity column's `(START WITH 5 INCREMENT BY 2)` as sequence options. */
function identityOptions(text: string | undefined): Parameters<typeof canonicalSequenceOptions>[0] {
  const o: Parameters<typeof canonicalSequenceOptions>[0] = {};
  if (!text) return o;
  const s = text.replace(/^\(|\)$/g, " ");
  const num = (re: RegExp) => re.exec(s)?.[1]?.replace(/\s+/g, "");
  o.increment = num(/increment\s+(?:by\s+)?(-?\s*\d+)/i);
  o.start = num(/start\s+(?:with\s+)?(-?\s*\d+)/i);
  o.cache = num(/cache\s+(\d+)/i);
  if (/no\s+minvalue/i.test(s)) o.minValue = null;
  else o.minValue = num(/minvalue\s+(-?\s*\d+)/i);
  if (/no\s+maxvalue/i.test(s)) o.maxValue = null;
  else o.maxValue = num(/maxvalue\s+(-?\s*\d+)/i);
  if (/\bno\s+cycle\b/i.test(s)) o.cycle = false;
  else if (/\bcycle\b/i.test(s)) o.cycle = true;
  o.type = /\bas\s+(\w+)/i.exec(s)?.[1];
  return o;
}

const deferralText = (c: { deferrable?: boolean; initiallyDeferred?: boolean }) =>
  [c.deferrable ? "deferrable" : "", c.initiallyDeferred ? "initially deferred" : ""].filter(Boolean).join(" ");

const keyBody = (kind: string, k: KeyDef) =>
  [kind, `(${k.columns.join(",")})`, k.nullsNotDistinct ? "nulls not distinct" : "", k.include ? `include (${canonicalExpr(k.include)})` : "", deferralText(k)]
    .filter(Boolean)
    .join(" ");

/** The pseudo-types (`pg_type.typtype = 'p'`), in `pg_catalog`: a routine's parameter or result, never a column's. */
const PSEUDO_TYPES = new Set([
  "any", "anyarray", "anycompatible", "anycompatiblearray", "anycompatiblemultirange", "anycompatiblenonarray", "anycompatiblerange",
  "anyelement", "anyenum", "anymultirange", "anynonarray", "anyrange", "cstring", "event_trigger", "fdw_handler", "index_am_handler",
  "internal", "language_handler", "pg_ddl_command", "record", "table_am_handler", "trigger", "tsm_handler", "unknown", "void",
]);

/** A parameter's or result's type as the catalog keeps it: canonical, its modifiers dropped (`varchar(20)` is `character varying`). */
export function canonicalArgType(text: string, defaultSchema: string): string {
  const m = /^\s*(?:pg_catalog\s*\.\s*)?([A-Za-z_]+)\s*((?:\[\s*\]\s*)*)$/.exec(text);
  if (m && PSEUDO_TYPES.has(m[1]!.toLowerCase())) return `${m[1]!.toLowerCase()}${"[]".repeat((m[2]!.match(/\[/g) ?? []).length)}`;
  return canonicalType(text, defaultSchema)!.replace(/\([^()]*\)/g, "");
}

/** A routine's input parameters: those whose mode is `in`, `inout` or `variadic`. */
const isInput = (a: { mode: string }) => a.mode !== "out";

/** A routine's identity among its overloads: its input parameter types, `(integer,text)`. */
export function routineSignature(p: Pick<RoutineProps, "args">, defaultSchema: string): string {
  return `(${p.args.filter(isInput).map((a) => canonicalArgType(a.type, defaultSchema)).join(",")})`;
}

/** The result a function declares, or the one its OUT parameters give it: one OUT is its type, several are `record`. */
function routineResult(p: RoutineProps, defaultSchema: string): string | undefined {
  if (p.returnsTable) return `table(${p.returnsTable.map((c) => `${quoteIdent(c.name)} ${canonicalArgType(c.type, defaultSchema)}`).join(",")})`;
  if (p.returns !== undefined) {
    const m = /^setof\s+(.*)$/is.exec(p.returns.trim());
    return m ? `setof ${canonicalArgType(m[1]!, defaultSchema)}` : canonicalArgType(p.returns, defaultSchema);
  }
  const outs = p.args.filter((a) => a.mode === "out" || a.mode === "inout");
  if (outs.length === 1) return canonicalArgType(outs[0]!.type, defaultSchema);
  if (outs.length > 1) return "record";
  return undefined;
}

/** A `SET` value as compared: each item unquoted, a bare word folded, `TO` and `=` alike. */
function canonicalSetting(value: string): string {
  const items: string[] = [];
  let tokens: Token[];
  try {
    tokens = tokenizeText(value, 0).filter((t) => !isTrivia(t));
  } catch {
    return value.trim();
  }
  let sign = "";
  for (const t of tokens) {
    if (t.kind === "punct" && t.text === ",") continue;
    if (t.kind === "op" && (t.text === "-" || t.text === "+")) {
      sign = t.text === "-" ? "-" : "";
      continue;
    }
    if (t.kind === "string") items.push(stringValue(t.text) ?? t.text);
    else if (t.kind === "qident") items.push(identValue(t));
    else items.push(`${sign}${t.kind === "ident" ? t.text.toLowerCase() : t.text}`);
    sign = "";
  }
  return items.join(", ");
}

/** The canonical fields of a function or procedure. */
function routineFields(kind: "function" | "procedure", p: RoutineProps, defaultSchema: string, fields: Record<string, unknown>): void {
  const lang = (p.language ?? "sql").toLowerCase();
  fields.args = p.args.map((a) =>
    [a.mode, a.name ? quoteIdent(a.name) : "", canonicalArgType(a.type, defaultSchema), a.default !== undefined ? `default ${canonicalExpr(a.default)}` : ""].filter(Boolean).join(" "),
  );
  fields.language = lang;
  // Line endings aside, the body is what the server keeps and prints back.
  fields.body = p.body.replace(/\r\n/g, "\n");
  fields.link = p.link;
  fields.securityDefiner = p.securityDefiner === true;
  fields.set = p.set && Object.keys(p.set).length > 0
    ? Object.fromEntries(Object.entries(p.set).map(([k, v]) => [k.toLowerCase(), canonicalSetting(v)]).sort(([a], [b]) => (a! < b! ? -1 : 1)))
    : undefined;
  fields.transform = p.transform ? canonicalExpr(p.transform) : undefined;
  if (kind === "procedure") return;
  const result = routineResult(p, defaultSchema);
  const setReturning = result !== undefined && /^(setof |table\()/.test(result);
  fields.returns = result;
  fields.volatility = p.volatility && p.volatility !== "volatile" ? p.volatility : undefined;
  fields.strict = p.strict === true;
  fields.leakproof = p.leakproof === true;
  fields.parallel = p.parallel && p.parallel !== "unsafe" ? p.parallel : undefined;
  const defaultCost = lang === "c" || lang === "internal" ? 1 : 100;
  fields.cost = p.cost !== undefined && Number(p.cost) !== defaultCost ? String(Number(p.cost)) : undefined;
  const defaultRows = setReturning ? 1000 : 0;
  fields.rows = p.rows !== undefined && Number(p.rows) !== defaultRows ? String(Number(p.rows)) : undefined;
  fields.support = p.support ? canonicalName(p.support, "pg_catalog").replace(/^pg_catalog\./, "") : undefined;
  fields.window = p.window === true;
}

/** A routine named with its parameters as a GRANT writes it (`app.f(int, text)`), as the target the catalog names: `app.f(integer,text)`. */
export function canonicalRoutineTarget(text: string, defaultSchema: string): string {
  const open = text.indexOf("(");
  const name = canonicalName(open < 0 ? text : text.slice(0, open), defaultSchema);
  if (open < 0) return name;
  try {
    // The parameter list read the way a CREATE FUNCTION reads it: modes, names and types.
    const tokens = tokenizeText(`CREATE FUNCTION x${text.slice(open)} RETURNS void LANGUAGE sql AS ''`, 0);
    const [node] = parseStatements(tokens);
    const args = (node as RoutineNode).args.map((a) => ({ mode: (a.mode?.toLowerCase() ?? "in") as RoutineProps["args"][number]["mode"], type: tokens.slice(a.type.from, a.type.to).map((t) => t.text).join("") }));
    return `${name}${routineSignature({ args }, defaultSchema)}`;
  } catch {
    return `${name}${text.slice(open).replace(/\s+/g, "")}`;
  }
}

/** A role's attributes that differ from `CREATE ROLE`'s defaults (NOLOGIN, INHERIT and every other NO...), sorted. */
const ROLE_DEFAULTS: Readonly<Record<string, boolean>> = { superuser: false, createdb: false, createrole: false, inherit: true, login: false, replication: false, bypassrls: false };

export function canonicalRoleAttributes(options: readonly string[]): string[] {
  const set: Record<string, boolean> = { ...ROLE_DEFAULTS };
  for (const o of options) {
    const word = o.toLowerCase();
    if (word.startsWith("no") && word.slice(2) in ROLE_DEFAULTS) set[word.slice(2)] = false;
    else if (word in ROLE_DEFAULTS) set[word] = true;
  }
  return Object.entries(set)
    .filter(([k, v]) => ROLE_DEFAULTS[k] !== v)
    .map(([k, v]) => (v ? k : `no${k}`))
    .sort();
}

/** The order the catalog prints a trigger's events in. */
const EVENT_ORDER = ["insert", "delete", "update", "truncate"];

/** A trigger argument as the catalog stores it: a string. */
function triggerArg(a: string): string {
  const t = a.trim();
  if (/^'/.test(t) || /^[Ee]'/.test(t) || /^\$/.test(t)) return stringValue(t) ?? t;
  if (/^"/.test(t)) return identValue(t);
  if (/^-?[0-9.]/.test(t)) return t.replace(/\s+/g, "");
  return t.toLowerCase();
}

function triggerFields(p: TriggerProps, defaultSchema: string, fields: Record<string, unknown>): void {
  fields.table = canonicalName(p.tableName, defaultSchema);
  fields.constraint = p.constraint === true;
  fields.timing = p.timing;
  fields.events = [...p.events]
    .sort((a, b) => EVENT_ORDER.indexOf(a.event) - EVENT_ORDER.indexOf(b.event))
    .map((e) => (e.columns && e.columns.length > 0 ? `${e.event} of ${[...e.columns].sort().map(quoteIdent).join(",")}` : e.event));
  fields.forEach = p.forEach;
  fields.when = canonicalExpr(p.when);
  fields.function = canonicalName(p.functionName, defaultSchema);
  fields.args = p.args.length > 0 ? p.args.map(triggerArg) : undefined;
  fields.from = p.from ? canonicalName(p.from, defaultSchema) : undefined;
  fields.deferrable = p.deferrable === true;
  fields.initiallyDeferred = p.initiallyDeferred === true;
  fields.referencing = p.referencing && (p.referencing.old || p.referencing.new)
    ? [p.referencing.old ? `old table as ${quoteIdent(p.referencing.old)}` : "", p.referencing.new ? `new table as ${quoteIdent(p.referencing.new)}` : ""].filter(Boolean).join(" ")
    : undefined;
}

// ── Types, aggregates, collations, casts, event triggers (#3911) ──────

/** The kinds that live in no schema. */
const UNPLACED: ReadonlySet<CanonicalKind> = new Set(["schema", "extension", "role", "cast", "eventTrigger", "foreignDataWrapper", "foreignServer", "publication"]);

/**
 * A function named where an object calls it (an aggregate's SFUNC, a cast's
 * or an event trigger's function), as the catalog's `regproc` prints it with
 * an empty search_path: a `pg_catalog` function bare, any other qualified. A
 * bare name that is no built-in function's is in the default schema.
 */
export function canonicalFunctionName(text: string, defaultSchema: string): string {
  const pieces = canonicalName(text).split(/\.(?=(?:[^"]*"[^"]*")*[^"]*$)/);
  if (pieces.length >= 2) return pieces[0] === "pg_catalog" ? pieces.slice(1).join(".") : pieces.join(".");
  const bare = identValue(pieces[0]!);
  return FUNCTIONS[bare] !== undefined ? pieces[0]! : `${quoteIdent(defaultSchema)}.${pieces[0]}`;
}

/** A collation named in a type or an attribute: canonical, a `pg_catalog` one bare (`"C"`), as the catalog prints it. */
export const canonicalCollation = (text: string): string => canonicalName(text).replace(/^pg_catalog\./, "");

/** A definition list's value as compared: a string constant's value, a word folded, other text canonical. */
function defValue(v: string): string {
  const t = v.trim();
  if (/^([Ee]?'|\$)/.test(t)) return stringValue(t) ?? t;
  if (/^"/.test(t)) return identValue(t);
  if (/^[A-Za-z_][A-Za-z0-9_$]*$/.test(t)) return t.toLowerCase();
  return canonicalExpr(t) ?? t;
}

/** A Postgres boolean option's value (`true`, `on`, `1`, `yes`), as written or given with no value. */
const isTrue = (v: string | undefined): boolean => v !== undefined && /^(true|on|1|yes|t|y)$/i.test(defValue(v));

/** The name Postgres gives a range type's multirange type when none is written: `range` in its name becomes `multirange`, else `_multirange` is added. */
export function defaultMultirangeName(range: string): string {
  const at = range.indexOf("range");
  return at >= 0 ? `${range.slice(0, at)}multi${range.slice(at)}` : `${range}_multirange`;
}

/** An aggregate's identity among its overloads: `(integer)`, `(*)`, `(text ORDER BY integer)`. */
export function aggregateSignature(p: Pick<AggregateProps, "args" | "orderBy">, defaultSchema: string): string {
  const types = (l: readonly AggregateArgDef[]) => l.map((a) => canonicalArgType(a.type, defaultSchema)).join(",");
  if (p.orderBy) return `(${p.args.length > 0 ? `${types(p.args)} ` : ""}ORDER BY ${types(p.orderBy)})`;
  return p.args.length === 0 ? "(*)" : `(${types(p.args)})`;
}

const AGGREGATE_FUNCTIONS = new Set(["sfunc", "finalfunc", "combinefunc", "serialfunc", "deserialfunc", "msfunc", "minvfunc", "mfinalfunc"]);
const AGGREGATE_TYPES = new Set(["stype", "mstype"]);
const AGGREGATE_FLAGS = new Set(["finalfunc_extra", "mfinalfunc_extra", "hypothetical"]);

/** An aggregate's definition as compared: each option canonical, the ones at their defaults left out. */
function aggregateOptions(p: AggregateProps, defaultSchema: string): Record<string, string> {
  const out: Record<string, string> = {};
  // A FINALFUNC_MODIFY not written is READ_ONLY for a plain aggregate, READ_WRITE for an ordered-set one.
  const modifyDefault = p.orderBy ? "read_write" : "read_only";
  for (const [k, v] of Object.entries(p.options)) {
    if (AGGREGATE_FUNCTIONS.has(k)) out[k] = canonicalFunctionName(v, defaultSchema);
    else if (AGGREGATE_TYPES.has(k)) out[k] = canonicalType(v, defaultSchema)!;
    else if (AGGREGATE_FLAGS.has(k)) {
      if (isTrue(v)) out[k] = "true";
    } else if (k === "sspace" || k === "msspace") {
      if (Number(defValue(v)) !== 0) out[k] = String(Number(defValue(v)));
    } else if (k === "finalfunc_modify" || k === "mfinalfunc_modify") {
      if (defValue(v) !== modifyDefault) out[k] = defValue(v);
    } else if (k === "sortop") {
      out[k] = v.trim().replace(/^OPERATOR\s*\(\s*(.*?)\s*\)$/is, "$1").replace(/^pg_catalog\s*\.\s*/i, "");
    } else if (k === "parallel") {
      if (defValue(v) !== "unsafe") out[k] = defValue(v);
    } else out[k] = defValue(v);
  }
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => (a < b ? -1 : 1)));
}

/** A collation's definition as compared: its provider (`libc` unless written) and locales, `deterministic` only when false. VERSION is the provider's, and is not compared. */
function collationFields(p: CollationProps, fields: Record<string, unknown>): void {
  const o = Object.fromEntries(Object.entries(p.options).map(([k, v]) => [k, defValue(v)]));
  const provider = o.provider ?? "libc";
  fields.provider = provider;
  if (provider === "libc") {
    fields.lcCollate = o.lc_collate ?? o.locale;
    fields.lcCtype = o.lc_ctype ?? o.locale;
  } else fields.locale = o.locale ?? o.lc_collate;
  fields.nondeterministic = p.options.deterministic !== undefined && !isTrue(p.options.deterministic);
  fields.rules = o.rules;
}

/** An operator's identity among its overloads: its operand types, `(integer,integer)`, `NONE` for a missing side. */
export function operatorSignature(p: Pick<OperatorProps, "leftArg" | "rightArg">, defaultSchema: string): string {
  const side = (t: string | undefined) => (t === undefined ? "NONE" : canonicalArgType(t, defaultSchema));
  return `(${side(p.leftArg)},${side(p.rightArg)})`;
}

/**
 * An operator named where another object names it (a COMMUTATOR or NEGATOR):
 * `OPERATOR(app.===)`, `app.===` or a bare symbol, which the server looks for
 * in the new operator's own schema, as `schema.symbol`.
 */
export function canonicalOperatorRef(text: string, ownSchema: string): string {
  const inner = text.trim().replace(/^OPERATOR\s*\(\s*(.*?)\s*\)$/is, "$1");
  const m = /^("(?:[^"]|"")+"|[A-Za-z_][A-Za-z0-9_$]*)\s*\.\s*(\S.*)$/s.exec(inner);
  return `${quoteIdent(m ? identValue(m[1]!) : ownSchema)}.${(m ? m[2]! : inner).trim()}`;
}

/** An operator's definition as compared: each function and operator named canonically, a flag only when set. */
function operatorOptions(p: OperatorProps, ownSchema: string, defaultSchema: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(p.options)) {
    if (k === "function" || k === "restrict" || k === "join") out[k] = canonicalFunctionName(v, defaultSchema);
    else if (k === "commutator" || k === "negator") out[k] = canonicalOperatorRef(v, ownSchema);
    else if (k === "hashes" || k === "merges") {
      if (isTrue(v)) out[k] = "true";
    } else out[k] = defValue(v);
  }
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => (a < b ? -1 : 1)));
}

/**
 * A name where an object is named (a text search parser, template or
 * dictionary, an operator family): the schema left off when it is
 * `pg_catalog` or the default schema, since a bare name is looked for in both.
 * The catalog prints every schema, so both sides are brought to this form.
 */
export function canonicalRef(text: string, defaultSchema: string): string {
  const pieces = canonicalName(text).split(/\.(?=(?:[^"]*"[^"]*")*[^"]*$)/);
  if (pieces.length >= 2) {
    const schema = identValue(pieces[0]!);
    return schema === "pg_catalog" || schema === defaultSchema ? pieces.slice(1).join(".") : pieces.join(".");
  }
  return pieces[0]!;
}

/** An operator named in an operator class: `OPERATOR(app.<<)`, `app.<<` or a bare symbol, by `canonicalRef`'s rule for the schema. */
export function canonicalOperatorName(text: string, defaultSchema: string): string {
  const inner = text.trim().replace(/^OPERATOR\s*\(\s*(.*?)\s*\)$/is, "$1").trim();
  const m = /^("(?:[^"]|"")+"|[A-Za-z_][A-Za-z0-9_$]*)\s*\.\s*(\S.*)$/s.exec(inner);
  if (!m) return inner;
  const schema = identValue(m[1]!);
  return schema === "pg_catalog" || schema === defaultSchema ? m[2]!.trim() : `${quoteIdent(schema)}.${m[2]!.trim()}`;
}

/** A comma list split at its top level: `numeric(12,2), text` is two items. */
function splitTopLevel(text: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let current = "";
  for (const ch of text) {
    if (ch === "(" || ch === "[") depth++;
    else if (ch === ")" || ch === "]") depth--;
    if (ch === "," && depth === 0) {
      out.push(current.trim());
      current = "";
    } else current += ch;
  }
  if (current.trim() !== "") out.push(current.trim());
  return out;
}

/**
 * The operand types a support function of an operator class is registered
 * for when `FUNCTION n (left, right)` does not say (sql-createopclass): a
 * B-tree comparison function's (1) and a hash function's (1, 2) are the
 * function's own input types, a B-tree `in_range` function's (3) its first
 * and third, and every other support function's the class's type. The catalog
 * always stores both, so a declaration is brought to them.
 */
function supportTypes(method: string, number: number, classType: string, args: readonly string[]): [string, string] {
  if (method === "btree" && number === 1) return [args[0] ?? classType, args[1] ?? args[0] ?? classType];
  if (method === "btree" && number === 3) return [args[0] ?? classType, args[2] ?? classType];
  if (method === "hash" && (number === 1 || number === 2)) return [args[0] ?? classType, args[0] ?? classType];
  return [classType, classType];
}

/** An operator class as compared: its type, family, default flag and members, each member canonical and the list sorted. */
function operatorClassFields(p: OperatorClassProps, schema: string, defaultSchema: string, fields: Record<string, unknown>): void {
  const type = canonicalType(p.dataType, defaultSchema)!;
  fields.default = p.default === true;
  fields.dataType = type;
  // A class with no FAMILY is in a family of its own name; so is one that names that family.
  const own = canonicalRef(`${quoteIdent(schema)}.${quoteIdent(p.name)}`, defaultSchema);
  const named = p.family === undefined ? own : /^\s*("(?:[^"]|"")+"|[A-Za-z_][A-Za-z0-9_$]*)\s*$/.test(p.family) && identValue(p.family.trim()) === p.name ? own : canonicalRef(p.family, defaultSchema);
  fields.family = named === own ? undefined : named;
  const side = (t: string) => (t.trim().toUpperCase() === "NONE" ? "NONE" : canonicalArgType(t, defaultSchema));
  const members = p.items.map((i): { rank: number; number: number; text: string } => {
    if (i.kind === "storage") return { rank: 2, number: 0, text: `storage ${canonicalType(i.type, defaultSchema)}` };
    const n = Number(i.number);
    if (i.kind === "operator") {
      const [l, r] = i.types !== undefined ? splitTopLevel(i.types) : [type, type];
      const sorted = i.orderBy !== undefined ? ` for order by ${canonicalRef(i.orderBy, defaultSchema)}` : "";
      return { rank: 0, number: n, text: `operator ${n} ${canonicalOperatorName(i.operator, defaultSchema)} (${side(l ?? type)},${side(r ?? l ?? type)})${sorted}` };
    }
    const args = splitTopLevel(i.args).map((a) => canonicalArgType(a, defaultSchema));
    const given = i.types !== undefined ? splitTopLevel(i.types).map(side) : undefined;
    const [l, r] = given ? [given[0]!, given[1] ?? given[0]!] : supportTypes(p.method, n, type, args);
    return { rank: 1, number: n, text: `function ${n} (${l},${r}) ${canonicalFunctionName(i.function, defaultSchema)}(${args.join(",")})` };
  });
  members.sort((a, b) => a.rank - b.rank || a.number - b.number || (a.text < b.text ? -1 : 1));
  fields.items = members.map((m) => m.text);
}

/** A dictionary option's value as compared: a string constant's value, a quoted name's, a bare word folded, a number as written. */
function dictionaryValue(v: string): string {
  const t = v.trim();
  if (/^([Ee]?'|\$)/.test(t)) return stringValue(t) ?? t;
  if (/^"/.test(t)) return identValue(t);
  return t.toLowerCase();
}

/** A text search configuration's mappings as compared: each token type to its dictionaries in order, sorted by token type. */
function mappingFields(p: TextSearchConfigurationProps, defaultSchema: string): Record<string, string[]> | undefined {
  const out: Record<string, string[]> = {};
  for (const m of p.mappings) for (const t of m.tokens) out[t.toLowerCase()] = m.dictionaries.map((d) => canonicalRef(d, defaultSchema));
  const entries = Object.entries(out).sort(([a], [b]) => (a < b ? -1 : 1));
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

/** An `OPTIONS (...)` list as compared: by name, none as nothing. */
function sortedOptions(options: Record<string, string> | undefined): Record<string, string> | undefined {
  const entries = Object.entries(options ?? {}).sort(([a], [b]) => (a < b ? -1 : 1));
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

const STATISTICS_ALL = ["dependencies", "mcv", "ndistinct"];

/**
 * The kinds of statistics gathered, sorted. Left out, the server builds all
 * three, except for a lone expression, which gets none of them (only the
 * expression's own statistics); `pg_get_statisticsobjdef` prints the list only
 * when it is not that default.
 */
export function statisticsKinds(kinds: readonly string[] | undefined, targets: readonly string[]): string[] | undefined {
  if (kinds && kinds.length > 0) {
    const sorted = [...new Set(kinds.map((k) => k.toLowerCase()))].sort();
    return sorted.join() === STATISTICS_ALL.join() ? undefined : sorted;
  }
  const lone = targets.length === 1 && !/^"?[A-Za-z_][A-Za-z0-9_$]*"?$/.test(targets[0]!.trim());
  return lone ? ["none"] : undefined;
}

/** Every action a publication publishes when `publish` is not given. */
const PUBLISH_ALL = ["delete", "insert", "truncate", "update"];

/** A publication as compared: its tables with their column lists and row filters, its schemas, and each option at its default left out. */
function publicationFields(p: PublicationProps, defaultSchema: string, fields: Record<string, unknown>): void {
  fields.allTables = p.allTables === true;
  const tables = p.tables.map((t) => ({
    table: canonicalName(t.tableName, defaultSchema),
    ...(t.columns && t.columns.length > 0 ? { columns: [...t.columns].sort() } : {}),
    ...(t.where ? { where: canonicalExpr(t.where) } : {}),
  }));
  fields.tables = tables.length > 0 ? tables.sort((a, b) => (a.table < b.table ? -1 : 1)) : undefined;
  fields.schemas = p.schemas.length > 0 ? p.schemas.map((s) => quoteIdent(identValue(s))).sort() : undefined;
  const o = p.options;
  const publish = o.publish === undefined ? PUBLISH_ALL : [...new Set(defValue(o.publish).split(",").map((x) => x.trim().toLowerCase()).filter(Boolean))].sort();
  fields.publish = publish.join() === PUBLISH_ALL.join() ? undefined : publish;
  fields.viaRoot = isTrue(o.publish_via_partition_root);
  const generated = o.publish_generated_columns === undefined ? "none" : defValue(o.publish_generated_columns);
  fields.generatedColumns = generated === "none" ? undefined : generated;
}

/** A cast's name, `(source AS target)`, its types canonical. */
export const castName = (p: Pick<CastProps, "sourceType" | "targetType">, defaultSchema: string): string =>
  `(${canonicalType(p.sourceType, defaultSchema)} AS ${canonicalType(p.targetType, defaultSchema)})`;

/**
 * A definition in canonical form. `props` is an entity's props, declared or
 * parsed from what the server printed; `defaultSchema` qualifies a bare name.
 */
export function canonicalPgObject(entityType: string, props: Record<string, unknown>, defaultSchema = "public"): CanonicalPgObject {
  const kind = kindOf[entityType];
  if (!kind) throw new Error(`not a Postgres entity type: ${entityType}`);
  const schemaOf = (p: { schema?: string }) => (UNPLACED.has(kind) || ACCESS_KINDS.has(kind) ? undefined : (p.schema ?? defaultSchema));
  const base: Pick<CanonicalPgObject, "kind" | "schema" | "name" | "signature"> = { kind, schema: schemaOf(props as { schema?: string }), name: String(props.name) };
  const fields: Record<string, unknown> = { comment: comment(props.comment as string | undefined) };
  const columns: CanonicalColumn[] = [];
  const constraints: CanonicalConstraint[] = [];

  switch (kind) {
    case "schema": {
      const p = props as unknown as SchemaProps;
      fields.authorization = p.authorization ? identValue(p.authorization) : undefined;
      break;
    }
    case "extension": {
      const p = props as unknown as ExtensionProps;
      fields.schema = p.schema;
      fields.version = p.version;
      break;
    }
    case "enum":
      fields.labels = (props as unknown as EnumProps).labels;
      break;
    case "composite": {
      const p = props as unknown as CompositeTypeProps;
      fields.attributeDefs = p.attributes.map((a) => `${quoteIdent(a.name)} ${canonicalType(a.type, defaultSchema)}${a.collate ? ` collate ${canonicalCollation(a.collate)}` : ""}`);
      break;
    }
    case "range": {
      const p = props as unknown as RangeTypeProps;
      fields.subtype = canonicalType(p.subtype, defaultSchema);
      fields.subtypeOpclass = p.subtypeOpclass ? canonicalName(p.subtypeOpclass).replace(/^pg_catalog\./, "") : undefined;
      fields.collation = p.collation ? canonicalCollation(p.collation) : undefined;
      fields.canonical = p.canonical ? canonicalFunctionName(p.canonical, defaultSchema) : undefined;
      fields.subtypeDiff = p.subtypeDiff ? canonicalFunctionName(p.subtypeDiff, defaultSchema) : undefined;
      // The multirange type is always named: as written, else as Postgres derives it, in the range's schema.
      fields.multirange = p.multirangeTypeName
        ? canonicalName(p.multirangeTypeName, base.schema)
        : canonicalName(quoteIdent(defaultMultirangeName(base.name)), base.schema);
      break;
    }
    case "aggregate": {
      const p = props as unknown as AggregateProps;
      base.signature = aggregateSignature(p, defaultSchema);
      fields.definition = aggregateOptions(p, defaultSchema);
      break;
    }
    case "collation":
      collationFields(props as unknown as CollationProps, fields);
      break;
    case "cast": {
      const p = props as unknown as CastProps;
      base.name = castName(p, defaultSchema);
      fields.castMethod = p.method;
      fields.function = p.functionName ? canonicalFunctionName(p.functionName, defaultSchema) : undefined;
      fields.context = p.context === "explicit" ? undefined : p.context;
      break;
    }
    case "eventTrigger": {
      const p = props as unknown as EventTriggerProps;
      fields.event = p.event.toLowerCase();
      fields.tags = p.tags && p.tags.length > 0 ? [...new Set(p.tags.map((t) => t.toUpperCase().replace(/\s+/g, " ").trim()))].sort() : undefined;
      fields.function = canonicalFunctionName(p.functionName, defaultSchema);
      break;
    }
    case "operator": {
      const p = props as unknown as OperatorProps;
      base.signature = operatorSignature(p, defaultSchema);
      fields.definition = operatorOptions(p, base.schema!, defaultSchema);
      break;
    }
    case "operatorClass":
      operatorClassFields(props as unknown as OperatorClassProps, base.schema!, defaultSchema, fields);
      base.signature = ` USING ${(props as unknown as OperatorClassProps).method}`;
      break;
    case "operatorFamily":
      base.signature = ` USING ${(props as unknown as OperatorFamilyProps).method}`;
      break;
    case "textSearchDictionary": {
      const p = props as unknown as TextSearchDictionaryProps;
      fields.template = canonicalRef(p.template, defaultSchema);
      fields.options = sortedOptions(Object.fromEntries(Object.entries(p.options).map(([k, v]) => [k.toLowerCase(), dictionaryValue(v)])));
      break;
    }
    case "textSearchConfiguration": {
      const p = props as unknown as TextSearchConfigurationProps;
      fields.parser = canonicalRef(p.parser, defaultSchema);
      fields.mappings = mappingFields(p, defaultSchema);
      break;
    }
    case "foreignTable": {
      const p = props as unknown as ForeignTableProps;
      p.columns.forEach((c: ColumnDef, position) => {
        const options = sortedOptions(c.options);
        columns.push({
          name: c.name,
          position,
          type: canonicalType(c.type, defaultSchema),
          notNull: c.notNull === true,
          default: canonicalExpr(c.default),
          collate: c.collate ? canonicalName(c.collate) : undefined,
          comment: comment(c.comment),
          ...(options ? { options } : {}),
        });
      });
      for (const c of p.checks) constraints.push({ kind: "CHECK", name: c.name, body: ["check", canonicalExpr(c.expr), c.noInherit ? "no inherit" : ""].filter(Boolean).join(" "), ...(c.notValid ? { notValid: true } : {}), comment: comment(c.comment) });
      fields.server = quoteIdent(p.serverName);
      fields.options = sortedOptions(p.options);
      break;
    }
    case "statistics": {
      const p = props as unknown as StatisticsProps;
      fields.table = canonicalName(p.tableName, defaultSchema);
      const targets = p.targets.map((t) => canonicalExpr(t)!).sort();
      fields.targets = targets;
      fields.kinds = statisticsKinds(p.kinds, p.targets);
      break;
    }
    case "foreignDataWrapper": {
      const p = props as unknown as ForeignDataWrapperProps;
      fields.handler = p.handlerName && !p.noHandler ? canonicalFunctionName(p.handlerName, defaultSchema) : undefined;
      fields.validator = p.validatorName && !p.noValidator ? canonicalFunctionName(p.validatorName, defaultSchema) : undefined;
      fields.options = sortedOptions(p.options);
      break;
    }
    case "foreignServer": {
      const p = props as unknown as ForeignServerProps;
      fields.serverType = p.serverType;
      fields.version = p.version;
      fields.wrapper = quoteIdent(identValue(p.wrapperName));
      fields.options = sortedOptions(p.options);
      break;
    }
    case "publication":
      publicationFields(props as unknown as PublicationProps, defaultSchema, fields);
      break;
    case "function":
    case "procedure": {
      const p = props as unknown as RoutineProps;
      base.signature = routineSignature(p, defaultSchema);
      routineFields(kind, p, defaultSchema, fields);
      break;
    }
    case "trigger": {
      const p = props as unknown as TriggerProps;
      triggerFields(p, defaultSchema, fields);
      base.signature = ` ON ${String(fields.table)}`;
      break;
    }
    case "policy": {
      const p = props as unknown as PolicyProps;
      fields.table = canonicalName(p.tableName, defaultSchema);
      base.signature = ` ON ${String(fields.table)}`;
      fields.restrictive = p.permissive === false;
      fields.command = p.command && p.command !== "all" ? p.command : undefined;
      const roles = [...new Set(p.roles.map((r) => r.toLowerCase() === "public" ? "public" : quoteIdent(r)))].sort();
      fields.roles = roles.length === 1 && roles[0] === "public" ? undefined : roles;
      fields.using = canonicalExpr(p.using);
      fields.check = canonicalExpr(p.check);
      break;
    }
    case "role": {
      const p = props as unknown as RoleProps;
      const attributes = canonicalRoleAttributes(p.options);
      fields.attributes = attributes.length > 0 ? attributes : undefined;
      fields.connectionLimit = p.connectionLimit !== undefined && Number(p.connectionLimit) !== -1 ? String(Number(p.connectionLimit)) : undefined;
      break;
    }
    case "grant": {
      const p = props as unknown as GrantProps;
      const routine = p.on === "function" || p.on === "procedure" || p.on === "routine";
      fields.grant = {
        action: p.action,
        on: p.on,
        objects: p.objectNames.map((n) => (routine ? canonicalRoutineTarget(n, defaultSchema) : p.on === "schema" ? canonicalName(n) : canonicalName(n, defaultSchema))),
        privileges: p.privileges.map((x) => ({ privilege: x.privilege.toLowerCase(), ...(x.columns ? { columns: x.columns } : {}) })),
        grantees: p.grantees,
        ...(p.withGrantOption ? { withGrantOption: true } : {}),
        ...(p.grantOptionFor ? { grantOptionFor: true } : {}),
      };
      break;
    }
    case "defaultPrivileges": {
      const p = props as unknown as DefaultPrivilegesProps;
      fields.grant = {
        action: p.action,
        on: p.on,
        privileges: p.privileges.map((x) => ({ privilege: x.toLowerCase() })),
        grantees: p.grantees,
        ...(p.forRoles ? { forRoles: p.forRoles } : {}),
        ...(p.inSchemas ? { inSchemas: p.inSchemas } : {}),
        ...(p.withGrantOption ? { withGrantOption: true } : {}),
        ...(p.grantOptionFor ? { grantOptionFor: true } : {}),
      };
      break;
    }
    case "domain": {
      const p = props as unknown as DomainProps;
      fields.dataType = canonicalType(p.dataType, defaultSchema);
      fields.collate = p.collate ? canonicalName(p.collate) : undefined;
      fields.default = canonicalExpr(p.default);
      fields.notNull = p.notNull === true;
      for (const c of p.checks) constraints.push({ kind: "CHECK", name: c.name, body: `check ${canonicalExpr(c.expr)}`, ...(c.notValid ? { notValid: true } : {}), comment: comment(c.comment) });
      break;
    }
    case "sequence": {
      const p = props as unknown as SequenceProps;
      fields.options = canonicalSequenceOptions({ ...p, type: p.dataType });
      fields.unlogged = p.persistence === "unlogged";
      fields.ownedBy = p.ownedBy && p.ownedBy.toUpperCase() !== "NONE" ? canonicalName(p.ownedBy) : undefined;
      break;
    }
    case "index": {
      const p = props as unknown as IndexProps;
      fields.table = canonicalName(p.tableName, defaultSchema);
      fields.unique = p.unique === true;
      fields.method = (p.method ?? "btree").toLowerCase();
      fields.elements = p.elements.map((e) => canonicalExpr(e.expr)!.replace(/ asc$/, "").replace(/ asc nulls last$/, "").replace(/ desc nulls first$/, " desc"));
      fields.include = p.include ? canonicalExpr(p.include) : undefined;
      fields.nullsNotDistinct = p.nullsNotDistinct === true;
      fields.with = canonicalOptions(p.with);
      fields.where = canonicalExpr(p.where);
      fields.tablespace = p.tablespace;
      break;
    }
    case "view":
    case "materializedView": {
      const p = props as unknown as ViewProps;
      fields.query = canonicalExpr(p.query);
      fields.columns = p.columns.length > 0 ? p.columns : undefined;
      const opts = canonicalOptions(p.with);
      fields.with = opts;
      fields.checkOption = p.checkOption ? (/local/i.test(p.checkOption) ? "local" : "cascaded") : undefined;
      if (kind === "materializedView") fields.withData = p.withData !== false;
      fields.columnComments = p.columnComments && Object.keys(p.columnComments).length ? p.columnComments : undefined;
      break;
    }
    case "table": {
      const p = props as unknown as TableProps;
      const pkColumns = new Set(p.primaryKey?.columns ?? []);
      p.columns.forEach((c: ColumnDef, position) => {
        const identity = c.generated?.kind === "identity";
        const serial = c.type !== undefined && /^(small|big)?serial$/i.test(c.type.trim());
        columns.push({
          name: c.name,
          position,
          type: canonicalType(c.type, defaultSchema),
          notNull: c.notNull === true || pkColumns.has(c.name) || identity || serial,
          default: canonicalExpr(c.default),
          generated: c.generated && !identity ? `${c.generated.kind} ${canonicalExpr(c.generated.expr)}` : undefined,
          identity: identity
            ? `${c.generated!.always ? "always" : "by default"}${(() => {
                const o = canonicalSequenceOptions(identityOptions(c.generated!.options), canonicalType(c.type));
                return o ? ` (${o})` : "";
              })()}`
            : undefined,
          collate: c.collate ? canonicalName(c.collate) : undefined,
          compression: c.compression?.toLowerCase(),
          storage: c.storage?.toLowerCase(),
          comment: comment(c.comment),
        });
      });
      if (p.primaryKey) constraints.push({ kind: "PRIMARY KEY", name: p.primaryKey.name, body: keyBody("primary key", p.primaryKey), comment: comment(p.primaryKey.comment) });
      for (const u of p.uniques) constraints.push({ kind: "UNIQUE", name: u.name, body: keyBody("unique", u), comment: comment(u.comment) });
      for (const c of p.checks as CheckDef[]) {
        constraints.push({
          kind: "CHECK",
          name: c.name,
          body: ["check", canonicalExpr(c.expr), c.noInherit ? "no inherit" : "", c.notEnforced ? "not enforced" : ""].filter(Boolean).join(" "),
          ...(c.notValid ? { notValid: true } : {}),
          comment: comment(c.comment),
        });
      }
      for (const f of p.foreignKeys) {
        const body = [
          `foreign key (${f.columns.join(",")}) references ${refTableOf(f, defaultSchema)}${f.refColumns.length ? `(${f.refColumns.join(",")})` : ""}`,
          f.match && f.match.toUpperCase() !== "SIMPLE" ? `match ${f.match.toLowerCase()}` : "",
          f.onUpdate && !/^no action$/i.test(f.onUpdate) ? `on update ${f.onUpdate.toLowerCase().replace(/\s+/g, " ")}` : "",
          f.onDelete && !/^no action$/i.test(f.onDelete) ? `on delete ${f.onDelete.toLowerCase().replace(/\s+/g, " ")}` : "",
          deferralText(f),
          f.notEnforced ? "not enforced" : "",
        ]
          .filter(Boolean)
          .join(" ");
        constraints.push({ kind: "FOREIGN KEY", name: f.name, body, ...(f.notValid ? { notValid: true } : {}), comment: comment(f.comment) });
      }
      for (const x of p.exclusions as ExclusionDef[]) {
        const body = [
          `exclude using ${(x.using ?? "btree").toLowerCase()} (${canonicalExpr(x.elements)})`,
          x.include ? `include (${canonicalExpr(x.include)})` : "",
          x.where ? `where (${canonicalExpr(x.where)})` : "",
          deferralText(x),
        ]
          .filter(Boolean)
          .join(" ");
        constraints.push({ kind: "EXCLUDE", name: x.name, body, comment: comment(x.comment) });
      }
      fields.unlogged = p.persistence === "unlogged";
      fields.partitionBy = canonicalExpr(p.partitionBy);
      fields.partitionOf = p.partitionOf ? canonicalName(typeof p.partitionOf === "string" ? p.partitionOf : p.partitionOf.sqlName, defaultSchema) : undefined;
      fields.partitionBound = canonicalExpr(p.partitionBound);
      fields.inherits = p.inherits.length ? p.inherits.map((i) => canonicalName(typeof i === "string" ? i : i.sqlName, defaultSchema)) : undefined;
      fields.using = p.using && p.using.toLowerCase() !== "heap" ? p.using.toLowerCase() : undefined;
      fields.with = canonicalOptions(p.with);
      fields.tablespace = p.tablespace;
      fields.rowSecurity = p.rowSecurity === true;
      fields.forceRowSecurity = p.forceRowSecurity === true;
      break;
    }
  }
  // Clauses the parser does not know (#3872): compared as text, by clause.
  const unparsed = props.unparsed as Array<{ clause: string; text: string; column?: string }> | undefined;
  if (unparsed && unparsed.length > 0) {
    const out: Record<string, string> = {};
    for (const u of unparsed) {
      const base = u.column !== undefined ? `columns.${u.column}.${u.clause}` : u.clause;
      let key = base;
      for (let n = 2; key in out; n++) key = `${base}#${n}`;
      out[key] = canonicalExpr(u.text) ?? u.text;
    }
    fields.unparsed = out;
  }
  return { ...base, fields: Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined && v !== false)), columns, constraints };
}

/** Whether two canonical constraints are the same one: the same body, and the same name when both declare one. */
export function sameConstraint(a: CanonicalConstraint, b: CanonicalConstraint): boolean {
  return a.kind === b.kind && a.body === b.body && (a.name === undefined || b.name === undefined || a.name === b.name);
}

/** A column without its position, for comparing two columns. */
export const columnShape = ({ position: _p, ...rest }: CanonicalColumn): string => JSON.stringify(rest);
