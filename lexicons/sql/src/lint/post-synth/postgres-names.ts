/**
 * Names in a Postgres declaration, read against the target major's catalog:
 * column types, function calls, index access methods and operator classes.
 * SQLPG119 to SQLPG126 share it.
 *
 * The line every check here keeps: a name the catalog or the project can
 * answer for is checked; a name qualified with a schema the project does not
 * declare (`billing.money`, `pg_catalog.int4`) is a plain-text reference and
 * left to the server; a name the core catalog lacks is a warning, not an
 * error, when the project declares an extension, since extension objects are
 * not in the catalog (`overlays/extension-objects.ts` covers the common ones).
 */

import type { PostSynthContext } from "@intentius/chant/lint/post-synth";
import { COLUMN_TYPES, FUNCTIONS, INDEX_ACCESS_METHODS, KEYWORDS, OPERATOR_CLASSES } from "../../generated/postgres";
import { EXTENSION_OBJECTS } from "../../postgres/overlays/extension-objects";
import { GRAMMAR_TYPE_SPELLINGS, SERIAL_TYPES, SERIAL_WIDTH_SPELLINGS, TYPE_SPELLINGS } from "../../postgres/overlays/types";
import { isTrivia, tokenizeText, type Token } from "../../postgres/tokens";
import type { ColumnTypeSpec } from "../../postgres/catalog-types";
import { targetMajor, type PgTable } from "./postgres-helpers";
import { postgresObjects, type OutputObject } from "./sql-helpers";

// ── Catalog lookups ────────────────────────────────────────────────────

type Presence = true | readonly number[] | undefined;
const presentAt = (p: Presence, major: number): boolean => p === true || (Array.isArray(p) && p.includes(major));
const majorsOf = (p: Presence): readonly number[] => (Array.isArray(p) ? p : []);

const columnTypes = COLUMN_TYPES as Readonly<Record<string, ColumnTypeSpec>>;

/** Every spelling of a built-in type (lower case, single spaces) to its `format_type()` name. */
const BUILTIN_SPELLINGS: ReadonlyMap<string, string> = (() => {
  const m = new Map<string, string>();
  for (const [sql, spec] of Object.entries(columnTypes)) {
    m.set(sql, sql);
    if (spec.catalogName) m.set(spec.catalogName, sql);
    for (const a of spec.aliases) if (!m.has(a)) m.set(a, sql);
  }
  for (const [a, sql] of [...Object.entries(TYPE_SPELLINGS), ...Object.entries(GRAMMAR_TYPE_SPELLINGS)]) if (!m.has(a)) m.set(a, sql);
  // `char` alone is `character` (bpchar); quoted, `"char"` is the one-byte type.
  m.set("char", "character");
  return m;
})();

const SERIALS: Readonly<Record<string, string>> = { ...SERIAL_TYPES, ...SERIAL_WIDTH_SPELLINGS };

/** The words that may follow `interval`: its fields. */
const INTERVAL_FIELDS = new Set(["year", "month", "day", "hour", "minute", "second", "to"]);

/** The catalog category of a built-in type (`N` numeric, `S` string...). */
export const categoryOf = (canonical: string): string | undefined => columnTypes[canonical]?.category;

/** The parameters a built-in type takes, from the overlay. */
export const parametersOf = (canonical: string) => columnTypes[canonical]?.parameters ?? [];

// ── Identifiers ────────────────────────────────────────────────────────

/** An identifier's value: a quoted one as written, a bare one folded to lower case. */
export function identValue(text: string): string {
  const t = text.trim();
  if (t.startsWith('"') && t.endsWith('"') && t.length >= 2) return t.slice(1, -1).replace(/""/g, '"');
  return t.toLowerCase();
}

/** Split on commas at depth 0. */
export function splitTopLevel(text: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let quote: string | undefined;
  let cur = "";
  for (const ch of text) {
    if (quote) {
      cur += ch;
      if (ch === quote) quote = undefined;
      continue;
    }
    if (ch === '"' || ch === "'") quote = ch;
    else if (ch === "(" || ch === "[") depth++;
    else if (ch === ")" || ch === "]") depth--;
    else if (ch === "," && depth === 0) {
      out.push(cur.trim());
      cur = "";
      continue;
    }
    cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

/** The bare column names of an `INCLUDE` list as the output keeps it (`b, "X"`, or `(b, c)`). */
export function includeColumns(text: string | undefined): string[] {
  if (!text) return [];
  const inner = text.trim().replace(/^\(/, "").replace(/\)$/, "");
  return splitTopLevel(inner).filter((s) => /^("([^"]|"")+"|[A-Za-z_][\w$]*)$/.test(s)).map(identValue);
}

function significant(text: string): Token[] | undefined {
  try {
    return tokenizeText(text, 0).filter((t) => !isTrivia(t));
  } catch {
    return undefined;
  }
}

const isName = (t: Token | undefined): boolean => t?.kind === "ident" || t?.kind === "qident";
const isPunct = (t: Token | undefined, p: string): boolean => t?.kind === "punct" && t.text === p;
const nameOf = (t: Token): string => (t.kind === "qident" ? identValue(t.text) : t.text.toLowerCase());

// ── The project ────────────────────────────────────────────────────────

/** What the build declares, for resolving a name to it. */
export interface PgProject {
  major: number;
  objects: OutputObject[];
  byExport: Map<string, OutputObject>;
  schemas: Set<string>;
  /** Declared extension names. */
  extensions: Set<string>;
}

export function projectOf(ctx: PostSynthContext): PgProject {
  const objects = postgresObjects(ctx);
  const byExport = new Map(objects.map((o) => [o.export, o]));
  const schemas = new Set(objects.filter((o) => o.type === "Postgres::Schema").map((o) => o.name));
  const exts = objects.filter((o) => o.type === "Postgres::Extension");
  return {
    major: targetMajor(ctx),
    objects,
    byExport,
    schemas,
    extensions: new Set(exts.map((o) => o.name)),
  };
}

const TYPE_OBJECTS = new Set(["Postgres::Enum", "Postgres::Domain", "Postgres::Table", "Postgres::View", "Postgres::MaterializedView"]);
const ROUTINES = new Set(["Postgres::Function", "Postgres::Procedure"]);

function declared(p: PgProject, kinds: ReadonlySet<string>, schema: string | undefined, name: string): OutputObject | undefined {
  return p.objects.find((o) => kinds.has(o.type) && o.name === name && (schema === undefined || o.schema === schema));
}

/** The extension that provides `name` in `section`, if the overlay knows one; declared ones first. */
function extensionFor(p: PgProject, test: (e: (typeof EXTENSION_OBJECTS)[string]) => boolean): { name: string; declared: boolean } | undefined {
  let found: { name: string; declared: boolean } | undefined;
  for (const [name, e] of Object.entries(EXTENSION_OBJECTS)) {
    if (!test(e)) continue;
    if (p.extensions.has(name)) return { name, declared: true };
    found ??= { name, declared: false };
  }
  return found;
}

/** A name the core catalog does not have: the finding's severity and a note, or nothing when an extension accounts for it. */
export interface Miss {
  severity: "error" | "warning";
  /** `, which comes from the pg_trgm extension the project does not declare` and the like. */
  note: string;
}

function miss(p: PgProject, ext: { name: string; declared: boolean } | undefined): Miss | undefined {
  if (ext?.declared) return undefined;
  if (ext) return { severity: "error", note: `; it comes from the ${ext.name} extension, which the project does not declare` };
  if (p.extensions.size > 0) return { severity: "warning", note: `; if an extension (${[...p.extensions].sort().join(", ")}) provides it, ignore this` };
  return { severity: "error", note: "" };
}

/** A schema-qualified name the project cannot answer for: one in a schema it does not declare. */
const outsideProject = (p: PgProject, schema: string): boolean => !p.schemas.has(schema);

// ── Types ──────────────────────────────────────────────────────────────

export interface ParsedType {
  schema?: string;
  /** The name: words joined by one space, bare words lower case. */
  name: string;
  quoted: boolean;
  /** The modifiers of the first `(...)`, as written. */
  modifiers?: string[];
  array: boolean;
  /** `interval`'s fields, upper case (`DAY TO SECOND`). */
  fields?: string;
}

/** A type as written in a column, domain or sequence: `numeric(12,2)`, `time(3) with time zone`, `app.mood[]`. Undefined when it is not a plain type name. */
export function parseType(text: string | undefined): ParsedType | undefined {
  if (!text) return undefined;
  const toks = significant(text);
  if (!toks || toks.length === 0) return undefined;
  const words: string[] = [];
  let schema: string | undefined;
  let quoted = false;
  let modifiers: string[] | undefined;
  let array = false;
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i]!;
    if (isName(t)) {
      if (t.kind === "ident" && t.text.toLowerCase() === "array" && words.length > 0) {
        array = true;
        continue;
      }
      if (array) return undefined;
      if (isPunct(toks[i + 1], ".") && words.length === 0 && schema === undefined && isName(toks[i + 2])) {
        schema = nameOf(t);
        i++;
        continue;
      }
      if (t.kind === "qident") quoted = true;
      words.push(nameOf(t));
    } else if (isPunct(t, "(")) {
      let depth = 1;
      let j = i + 1;
      for (; j < toks.length && depth > 0; j++) {
        if (isPunct(toks[j], "(")) depth++;
        else if (isPunct(toks[j], ")")) depth--;
      }
      if (depth !== 0) return undefined;
      if (modifiers === undefined) {
        const start = t.end;
        const end = toks[j - 1]!.start;
        modifiers = splitTopLevel(text.slice(start, end));
      }
      i = j - 1;
    } else if (isPunct(t, "[")) {
      array = true;
      let j = i + 1;
      while (j < toks.length && !isPunct(toks[j], "]")) j++;
      i = j;
    } else {
      return undefined;
    }
  }
  if (words.length === 0) return undefined;
  if (!quoted && words[0] === "interval" && words.length > 1 && words.slice(1).every((w) => INTERVAL_FIELDS.has(w))) {
    return { schema, name: "interval", quoted, modifiers, array, fields: words.slice(1).join(" ").toUpperCase() };
  }
  return { schema, name: words.join(" "), quoted, modifiers, array };
}

export type TypeResolution =
  | { kind: "builtin"; canonical: string; serial?: boolean }
  | { kind: "declared"; object: OutputObject }
  /** Qualified with a schema the project does not declare, or provided by a declared extension: not checked. */
  | { kind: "outside" }
  | { kind: "missing"; miss: Miss }
  /** A built-in type the target major does not have. */
  | { kind: "absent"; canonical: string };

/** Resolve a parsed type at the target major. `serial` admits `serial` and friends (a column). */
export function resolveType(p: PgProject, t: ParsedType, opts: { serial?: boolean } = {}): TypeResolution {
  if (t.schema !== undefined) {
    if (outsideProject(p, t.schema)) return { kind: "outside" };
    const d = declared(p, TYPE_OBJECTS, t.schema, t.name);
    if (d) return { kind: "declared", object: d };
    const m = miss(p, extensionFor(p, (e) => e.types?.includes(t.name) ?? false));
    return m ? { kind: "missing", miss: m } : { kind: "outside" };
  }
  if (!t.quoted) {
    if (opts.serial && SERIALS[t.name] && !t.modifiers) return { kind: "builtin", canonical: SERIALS[t.name]!, serial: true };
    if (t.name === "float" && t.modifiers?.length === 1 && /^\d+$/.test(t.modifiers[0]!)) {
      return { kind: "builtin", canonical: Number(t.modifiers[0]) <= 24 ? "real" : "double precision" };
    }
    const canonical = BUILTIN_SPELLINGS.get(t.name) ?? (t.name.startsWith("_") ? BUILTIN_SPELLINGS.get(t.name.slice(1)) : undefined);
    if (canonical) return { kind: "builtin", canonical };
  } else {
    if (t.name === "char") return { kind: "builtin", canonical: '"char"' };
    const byCatalog = Object.entries(columnTypes).find(([sql, s]) => (s.catalogName ?? sql) === t.name);
    if (byCatalog) return { kind: "builtin", canonical: byCatalog[0] };
  }
  const d = declared(p, TYPE_OBJECTS, undefined, t.name);
  if (d) return { kind: "declared", object: d };
  const m = miss(p, extensionFor(p, (e) => e.types?.includes(t.name) ?? false));
  return m ? { kind: "missing", miss: m } : { kind: "outside" };
}

/** A type as the user wrote it, for a message. */
export const typeLabel = (t: ParsedType): string => `${t.schema ? `${t.schema}.` : ""}${t.name}`;

/**
 * A comparable identity for a column's type, for a foreign key: a built-in
 * type's catalog category (`U`, the catch-all, by name), a domain's base type,
 * an enum or row type by name; `[]` for an array. Undefined when it cannot be
 * told (a type outside the project).
 */
export function typeIdentity(p: PgProject, text: string | undefined, depth = 0): string | undefined {
  const t = parseType(text);
  if (!t || depth > 5) return undefined;
  const r = resolveType(p, t, { serial: true });
  const suffix = t.array ? "[]" : "";
  if (r.kind === "builtin") {
    const cat = categoryOf(r.canonical);
    if (!cat) return undefined;
    return (cat === "U" ? `U:${r.canonical}` : cat) + suffix;
  }
  if (r.kind === "declared") {
    if (r.object.type === "Postgres::Domain") {
      const base = typeIdentity(p, r.object.dataType as string | undefined, depth + 1);
      return base === undefined ? undefined : base + suffix;
    }
    return `${r.object.type}:${r.object.sqlName as string}${suffix}`;
  }
  return undefined;
}

// ── Calls ──────────────────────────────────────────────────────────────

/**
 * Words that take a parenthesis in an expression without being a call to a
 * function in `pg_proc`. Reserved and column-name key words (`COALESCE`,
 * `CAST`, `EXTRACT`, `ROW`, `ARRAY`, `EXISTS`, `IN`, `ANY`, `SUBSTRING`...)
 * are not function names to the grammar and are skipped by their category;
 * these are the unreserved ones that read the same way.
 */
const NOT_CALLS = new Set(["filter", "over", "within", "zone", "varying", "precision", "value", "and", "or", "not", "as", "then", "else", "when"]);

export interface Call {
  schema?: string;
  name: string;
}

/** The function calls in an expression: a name directly followed by `(`, outside string literals, not a key word construct. */
export function callsIn(expr: string | undefined): Call[] {
  if (!expr) return [];
  const toks = significant(expr);
  if (!toks) return [];
  const out: Call[] = [];
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i]!;
    if (!isName(t)) continue;
    const prev = toks[i - 1];
    if (isPunct(prev, ".")) continue;
    // A type's modifiers after a cast: `x::numeric(10, 2)`, `CAST(x AS varchar(3))`.
    if (prev?.kind === "op" && prev.text === "::") continue;
    if (prev?.kind === "ident" && prev.text.toLowerCase() === "as") continue;
    if (isPunct(toks[i + 1], ".") && isName(toks[i + 2]) && isPunct(toks[i + 3], "(")) {
      out.push({ schema: nameOf(t), name: nameOf(toks[i + 2]!) });
      i += 2;
      continue;
    }
    if (!isPunct(toks[i + 1], "(")) continue;
    if (t.kind === "ident") {
      const w = t.text.toLowerCase();
      const cat = KEYWORDS[w];
      if (cat === "R" || cat === "C" || cat === "T") continue;
      if (NOT_CALLS.has(w)) continue;
    }
    out.push({ name: nameOf(t) });
  }
  return out;
}

export type CallResolution = { ok: true } | { ok: false; miss: Miss; since?: number; until?: number };

/** Resolve a call at the target major. */
export function resolveCall(p: PgProject, c: Call): CallResolution {
  if (c.schema !== undefined) {
    if (outsideProject(p, c.schema)) return { ok: true };
    if (declared(p, ROUTINES, c.schema, c.name)) return { ok: true };
    const m = miss(p, extensionFor(p, (e) => providesFunction(e, c.name)));
    return m ? { ok: false, miss: m } : { ok: true };
  }
  const presence = (FUNCTIONS as Readonly<Record<string, Presence>>)[c.name];
  if (presentAt(presence, p.major)) return { ok: true };
  if (declared(p, ROUTINES, undefined, c.name)) return { ok: true };
  // A function-style cast: `int4(x)`, `text(x)`, or a declared type's name.
  if (BUILTIN_SPELLINGS.has(c.name) || declared(p, TYPE_OBJECTS, undefined, c.name)) return { ok: true };
  if (presence !== undefined) {
    const ms = majorsOf(presence);
    const since = ms[0]! > p.major ? ms[0] : undefined;
    const until = ms[ms.length - 1]! < p.major ? ms[ms.length - 1] : undefined;
    return { ok: false, miss: { severity: "error", note: "" }, since, until };
  }
  const m = miss(p, extensionFor(p, (e) => providesFunction(e, c.name)));
  return m ? { ok: false, miss: m } : { ok: true };
}

function providesFunction(e: (typeof EXTENSION_OBJECTS)[string], name: string): boolean {
  return (e.functions?.includes(name) ?? false) || (e.functionPrefixes?.some((pre) => name.startsWith(pre)) ?? false);
}

/** The expressions of a table, domain or index that may call functions, each with where it sits. */
export function expressionsOf(o: OutputObject): Array<{ where: string; expr: string }> {
  const out: Array<{ where: string; expr: string }> = [];
  if (o.type === "Postgres::Table") {
    const t = o as PgTable;
    for (const c of t.columns) {
      if (c.default) out.push({ where: `column ${c.name}'s DEFAULT`, expr: c.default });
      if (c.generated?.expr) out.push({ where: `generated column ${c.name}`, expr: c.generated.expr });
    }
    for (const k of t.checks) out.push({ where: k.name ? `CHECK ${k.name}` : "a CHECK", expr: k.expr });
  } else if (o.type === "Postgres::Domain") {
    if (o.default) out.push({ where: "its DEFAULT", expr: o.default as string });
    for (const k of (o.checks as Array<{ name?: string; expr: string }> | undefined) ?? []) out.push({ where: k.name ? `CHECK ${k.name}` : "a CHECK", expr: k.expr });
  } else if (o.type === "Postgres::Index") {
    for (const e of (o.elements as Array<{ expr: string; column?: string }>) ?? []) {
      if (e.column) continue;
      const el = parseIndexElement(e.expr);
      out.push({ where: "an index expression", expr: el?.expr ?? e.expr });
    }
  }
  return out;
}

// ── Index elements ─────────────────────────────────────────────────────

export interface IndexElement {
  /** The column or expression, without its collation, operator class or ordering. */
  expr: string;
  opclass?: { schema?: string; name: string };
}

const ORDERING = new Set(["asc", "desc", "nulls", "first", "last"]);

/** An index element (`(lower(x)) text_pattern_ops DESC`, `x gin_trgm_ops`) split into its expression and operator class. */
export function parseIndexElement(text: string): IndexElement | undefined {
  const toks = significant(text);
  if (!toks || toks.length === 0) return undefined;
  let i = 0;
  const skipGroup = (at: number): number => {
    let depth = 0;
    for (let j = at; j < toks.length; j++) {
      if (isPunct(toks[j], "(")) depth++;
      else if (isPunct(toks[j], ")") && --depth === 0) return j + 1;
    }
    return toks.length;
  };
  if (isPunct(toks[0], "(")) i = skipGroup(0);
  else if (isName(toks[0])) {
    i = 1;
    while (isPunct(toks[i], ".") && isName(toks[i + 1])) i += 2;
    if (isPunct(toks[i], "(")) i = skipGroup(i);
  } else return undefined;
  const expr = text.slice(toks[0]!.start, toks[i - 1]!.end);
  if (toks[i]?.kind === "ident" && toks[i]!.text.toLowerCase() === "collate") {
    i += 2;
    while (isPunct(toks[i], ".") && isName(toks[i + 1])) i += 2;
  }
  const t = toks[i];
  if (!isName(t) || (t!.kind === "ident" && ORDERING.has(t!.text.toLowerCase()))) return { expr };
  if (isPunct(toks[i + 1], ".") && isName(toks[i + 2])) return { expr, opclass: { schema: nameOf(t!), name: nameOf(toks[i + 2]!) } };
  return { expr, opclass: { name: nameOf(t!) } };
}

export type MethodResolution = { ok: true } | { ok: false; miss: Miss; since?: number; until?: number };

/** An index access method at the target major. */
export function resolveMethod(p: PgProject, method: string): MethodResolution {
  const presence = (INDEX_ACCESS_METHODS as Readonly<Record<string, Presence>>)[method];
  if (presentAt(presence, p.major)) return { ok: true };
  if (presence !== undefined) return { ok: false, miss: { severity: "error", note: "" } };
  const m = miss(p, extensionFor(p, (e) => e.accessMethods?.includes(method) ?? false));
  return m ? { ok: false, miss: m } : { ok: true };
}

export type OpClassResolution = { ok: true } | { ok: false; miss: Miss; otherMethods?: string[] };

/** An operator class for `method` at the target major. */
export function resolveOpClass(p: PgProject, method: string, opclass: { schema?: string; name: string }): OpClassResolution {
  if (opclass.schema !== undefined && outsideProject(p, opclass.schema)) return { ok: true };
  const classes = OPERATOR_CLASSES as Readonly<Record<string, Readonly<Record<string, Presence>>>>;
  if (presentAt(classes[method]?.[opclass.name], p.major)) return { ok: true };
  const ext = extensionFor(p, (e) => e.opclasses?.[method]?.includes(opclass.name) ?? false);
  if (ext?.declared) return { ok: true };
  if (!ext) {
    const others = Object.keys(classes).filter((am) => am !== method && presentAt(classes[am]![opclass.name], p.major));
    const extOthers = Object.entries(EXTENSION_OBJECTS).flatMap(([, e]) => Object.entries(e.opclasses ?? {}).filter(([am, names]) => am !== method && names.includes(opclass.name)).map(([am]) => am));
    const all = [...new Set([...others, ...extOthers])].sort();
    if (all.length > 0) return { ok: false, miss: { severity: "error", note: "" }, otherMethods: all };
  }
  const m = miss(p, ext);
  return m ? { ok: false, miss: m } : { ok: true };
}

// ── Tables ─────────────────────────────────────────────────────────────

/** The table an interpolated reference names (`references`, `table`, a grant's object): the entity when it is one, else undefined. */
export function interpolatedTable(p: PgProject, ref: unknown, sqlName: string | undefined): PgTable | undefined {
  if (typeof ref !== "string") return undefined;
  const o = p.byExport.get(ref);
  if (!o || o.type !== "Postgres::Table") return undefined;
  if (sqlName !== undefined && o.sqlName !== sqlName) return undefined;
  return o as PgTable;
}

/**
 * Every column a table has, its own and those it inherits or copies from a
 * declared parent; undefined when some come from somewhere the build cannot
 * see (a plain-text parent, `LIKE`, `OF type`).
 */
export function columnsOf(p: PgProject, t: PgTable, seen = new Set<string>()): Map<string, PgTable["columns"][number]> | undefined {
  if (seen.has(t.export)) return undefined;
  seen.add(t.export);
  if (t.ofType !== undefined || t.like.length > 0) return undefined;
  const out = new Map<string, PgTable["columns"][number]>();
  const parents: unknown[] = [...(t.inherits ?? []), ...(t.partitionOf !== undefined ? [t.partitionOf] : [])];
  for (const parent of parents) {
    const pt = interpolatedTable(p, parent, undefined);
    if (!pt) return undefined;
    const pc = columnsOf(p, pt, seen);
    if (!pc) return undefined;
    for (const [k, v] of pc) out.set(k, v);
  }
  // A partition's `col WITH OPTIONS ...` carries no type; the parent's column stands.
  for (const c of t.columns) if (c.type !== undefined || !out.has(c.name)) out.set(c.name, c);
  return out;
}
