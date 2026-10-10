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
import { COLUMN_TYPES } from "../../generated/postgres";
import { stripMarker } from "../../core/ownership";
import { sequenceDefaults } from "../live/catalog";
import type {
  CheckDef,
  ColumnDef,
  DomainProps,
  EnumProps,
  ExclusionDef,
  ExtensionProps,
  ForeignKeyDef,
  IndexProps,
  KeyDef,
  SchemaProps,
  RoutineProps,
  SequenceProps,
  TableProps,
  TriggerProps,
  ViewProps,
} from "../entities";
import { stringValue } from "../entities";

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

export type CanonicalKind = "schema" | "table" | "index" | "view" | "materializedView" | "sequence" | "enum" | "domain" | "extension" | "function" | "procedure" | "trigger";

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
  "Postgres::Domain": "domain",
  "Postgres::Extension": "extension",
  "Postgres::Function": "function",
  "Postgres::Procedure": "procedure",
  "Postgres::Trigger": "trigger",
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

/**
 * A definition in canonical form. `props` is an entity's props, declared or
 * parsed from what the server printed; `defaultSchema` qualifies a bare name.
 */
export function canonicalPgObject(entityType: string, props: Record<string, unknown>, defaultSchema = "public"): CanonicalPgObject {
  const kind = kindOf[entityType];
  if (!kind) throw new Error(`not a Postgres entity type: ${entityType}`);
  const schemaOf = (p: { schema?: string }) => (kind === "schema" || kind === "extension" ? undefined : (p.schema ?? defaultSchema));
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
      break;
    }
  }
  return { ...base, fields: Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined && v !== false)), columns, constraints };
}

/** Whether two canonical constraints are the same one: the same body, and the same name when both declare one. */
export function sameConstraint(a: CanonicalConstraint, b: CanonicalConstraint): boolean {
  return a.kind === b.kind && a.body === b.body && (a.name === undefined || b.name === undefined || a.name === b.name);
}

/** A column without its position, for comparing two columns. */
export const columnShape = ({ position: _p, ...rest }: CanonicalColumn): string => JSON.stringify(rest);
