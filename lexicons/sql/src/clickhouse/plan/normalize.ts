/**
 * Normalization: a ClickHouse object's definition in a form two definitions
 * can be compared in, so a declaration and what the server reports for it are
 * equal when they mean the same thing (#3047 question 4).
 *
 * The server rewrites what it is given. `SHOW CREATE` quotes every column,
 * qualifies names with their database, writes `INTERVAL 180 DAY` as
 * `toIntervalDay(180)`, fills in codec levels (`ZSTD(1)`, `Delta(4)`), drops a
 * TTL's trailing `DELETE`, prints `index_granularity = 8192`, writes `int` as
 * `Int32` and infers a view's column list. Each of those is undone here, on
 * both sides, by rule:
 *
 * - expressions compare as their token sequences, whitespace, comments and
 *   identifier quoting left out, keywords in upper case, `INTERVAL n UNIT`
 *   rewritten to `toIntervalUnit(n)`, the object's own database dropped from a
 *   qualified name;
 * - a type's family is its canonical name (`int` is `Int32`), from the pinned
 *   catalog's alias table;
 * - a codec's default level goes (`ZSTD(1)` is `ZSTD`, `Delta(4)` is `Delta`);
 * - a TTL rule's trailing `DELETE` goes;
 * - a setting at the pinned server's default goes;
 * - a view's column list is not compared: the server infers it.
 *
 * What the rules cannot see is the server's own expression formatting
 * (`a+b*2` prints as `a + (b * 2)`). When a plan reads a live server it asks
 * that server's formatter (`formatQuerySingleLine`, a read with no side
 * effects) about any expression the rules leave different
 * (`./server-format.ts`). Nothing is created anywhere to normalize: a scratch
 * database on the target would start Kafka consumers and register replicas in
 * Keeper, and a scratch container would need Docker at plan time and could
 * differ from the server in version.
 */

import { isTrivia, tokenizeText, type Token } from "../tokens";
import { parseCreate, unquote, type ColumnNode, type CreateNode, type DictionaryAttributeNode, type DictionaryNode, type Span } from "../parser";
import { MERGE_TREE_SETTINGS, TYPE_FAMILIES } from "../../generated/clickhouse";
import { previouslyIn, splitTopLevel as splitTop } from "../../core/normalize";

export { previouslyIn } from "../../core/normalize";

export type ObjectKind = "database" | "table" | "view" | "materializedView" | "dictionary" | "function";

export interface CanonicalColumn {
  name: string;
  position: number;
  type: string;
  nullable?: boolean;
  defaultKind?: string;
  defaultExpr?: string;
  codec?: string;
  ttl?: string;
  comment?: string;
  /** A dictionary attribute's `EXPRESSION`. */
  expression?: string;
  /** A dictionary attribute's flags, sorted: `HIERARCHICAL`, `INJECTIVE`. */
  flags?: string;
  /** `-- previously: <name>` on the column's line: the name it had before. */
  previously?: string;
  /** The column's name and type as written, for a message. Not compared. */
  text: string;
}

export interface CanonicalObject {
  kind: ObjectKind;
  database?: string;
  name: string;
  engine?: string;
  /** The engine's name alone. */
  engineName?: string;
  columns: CanonicalColumn[];
  orderBy?: string;
  primaryKey?: string;
  partitionBy?: string;
  sampleBy?: string;
  ttl?: string;
  settings: Record<string, string>;
  indexes: Record<string, string>;
  projections: Record<string, string>;
  constraints: Record<string, string>;
  comment?: string;
  select?: string;
  to?: string;
  refresh?: string;
  /** A dictionary's `SOURCE`, `LAYOUT`, `LIFETIME` and `RANGE`, each what is inside the parentheses. */
  dataSource?: string;
  layout?: string;
  lifetime?: string;
  range?: string;
  /** A function's lambda, `( x , y ) -> expr`. */
  lambda?: string;
  /** `-- previously: <name>` before the statement: the object's previous name. */
  previously?: string;
}

const KEYWORDS = new Set(
  (
    "AS AND OR NOT IN IS NULL LIKE ILIKE BETWEEN CASE WHEN THEN ELSE END INTERVAL ASC DESC NULLS FIRST LAST " +
    "SELECT FROM WHERE GROUP BY ORDER HAVING LIMIT OFFSET JOIN LEFT RIGHT INNER OUTER FULL CROSS ON USING ARRAY " +
    "DISTINCT ALL ANY UNION WITH TOTALS ROLLUP CUBE PREWHERE SETTINGS FORMAT GLOBAL SEMI ANTI ASOF FINAL SAMPLE " +
    "DELETE TO DISK VOLUME RECOMPRESS SET TRUE FALSE EVERY AFTER RANDOMIZE FOR DEPENDS APPEND"
  ).split(" "),
);

const INTERVAL_UNITS: Record<string, string> = {
  NANOSECOND: "Nanosecond",
  MICROSECOND: "Microsecond",
  MILLISECOND: "Millisecond",
  SECOND: "Second",
  MINUTE: "Minute",
  HOUR: "Hour",
  DAY: "Day",
  WEEK: "Week",
  MONTH: "Month",
  QUARTER: "Quarter",
  YEAR: "Year",
};

const isName = (t: Token | undefined) => t !== undefined && (t.kind === "ident" || t.kind === "qident");

/**
 * The Keeper path and replica name a `Replicated*MergeTree` gets when its
 * declaration leaves them out: the stock `default_replica_path` and
 * `default_replica_name`, which `SHOW CREATE` then prints.
 */
export const DEFAULT_REPLICA_PATH = "'/clickhouse/tables/{uuid}/{shard}'";
export const DEFAULT_REPLICA_NAME = "'{replica}'";

/** One token's canonical text. */
function tokenText(t: Token): string {
  if (t.kind === "qident") return unquote(t.text);
  if (t.kind === "ident" && KEYWORDS.has(t.text.toUpperCase())) return t.text.toUpperCase();
  return t.text;
}

/**
 * An expression's canonical text: its significant tokens joined by single
 * spaces, with the rewrites the server makes undone.
 */
export function canonicalExpression(text: string, ownDatabase?: string): string {
  let sig: Token[];
  try {
    sig = tokenizeText(text, 0).filter((t) => !isTrivia(t));
  } catch {
    return text.trim();
  }
  const out: string[] = [];
  for (let i = 0; i < sig.length; i++) {
    const t = sig[i]!;
    // INTERVAL 180 DAY  ->  toIntervalDay(180)
    if (t.kind === "ident" && t.text.toUpperCase() === "INTERVAL" && sig[i + 1] && sig[i + 2]) {
      const unit = INTERVAL_UNITS[sig[i + 2]!.text.toUpperCase().replace(/S$/, "")];
      if (unit && (sig[i + 1]!.kind === "number" || sig[i + 1]!.kind === "ref" || isName(sig[i + 1]))) {
        out.push(`toInterval${unit}`, "(", tokenText(sig[i + 1]!), ")");
        i += 2;
        continue;
      }
    }
    // own_db.name  ->  name
    if (ownDatabase !== undefined && isName(t) && unquote(t.text) === ownDatabase && sig[i + 1]?.text === "." && isName(sig[i + 2])) {
      const prev = sig[i - 1];
      if (!(prev?.kind === "punct" && prev.text === ".")) {
        i += 1;
        continue;
      }
    }
    out.push(tokenText(t));
  }
  return unwrapSingle(out).join(" ");
}

/** `( a )` with no top-level comma is `a`; `tuple ( )` is empty. */
function unwrapSingle(tokens: string[]): string[] {
  if (tokens.length === 3 && tokens[0]!.toLowerCase() === "tuple" && tokens[1] === "(" && tokens[2] === ")") return [];
  if (tokens[0] !== "(" || tokens[tokens.length - 1] !== ")") return tokens;
  let depth = 0;
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i] === "(") depth++;
    else if (tokens[i] === ")") depth--;
    if (depth === 0 && i < tokens.length - 1) return tokens;
    if (depth === 1 && tokens[i] === ",") return tokens;
  }
  return unwrapSingle(tokens.slice(1, -1));
}

/** A type with its family names canonical: `int` is `Int32`, `BIGINT` is `Int64`. */
export function canonicalType(text: string): string {
  const families = TYPE_FAMILIES as Record<string, { canonical: string; caseInsensitive: boolean } | undefined>;
  const lower = new Map<string, string>();
  for (const [name, spec] of Object.entries(families)) if (spec?.caseInsensitive) lower.set(name.toLowerCase(), spec.canonical);
  return canonicalExpression(text)
    .split(" ")
    .map((w) => families[w]?.canonical ?? lower.get(w.toLowerCase()) ?? w)
    .join(" ");
}

const CODEC_DEFAULT_ARGS: Record<string, (args: string) => boolean> = {
  ZSTD: (a) => a === "1",
  LZ4HC: (a) => a === "0" || a === "9",
  Delta: () => true,
  DoubleDelta: () => true,
  Gorilla: () => true,
  T64: (a) => a === "'byte'",
};

/** A codec chain with each codec's default level left out. */
export function canonicalCodec(text: string): string {
  return splitTop(canonicalExpression(text))
    .map((c) => {
      const m = /^(\w+) \( (.*) \)$/.exec(c);
      if (!m) return c;
      const [, name, args] = m;
      return CODEC_DEFAULT_ARGS[name!]?.(args!) ? name! : c;
    })
    .join(" , ");
}

/** A TTL with each rule's trailing `DELETE` (the default action) left out. */
export function canonicalTtl(text: string, ownDatabase?: string): string {
  return splitTop(canonicalExpression(text, ownDatabase))
    .map((rule) => rule.replace(/ DELETE$/, ""))
    .join(" , ");
}

function spanText(tokens: Token[], span: Span | undefined): string | undefined {
  if (!span || span.to <= span.from) return undefined;
  return tokens
    .slice(span.from, span.to)
    .map((t) => t.text)
    .join("")
    .trim();
}

/** The comments on the line a column starts on, after its name. */
function lineComments(tokens: Token[], from: number): string[] {
  const out: string[] = [];
  for (let i = from + 1; i < tokens.length; i++) {
    const t = tokens[i]!;
    if (t.kind === "ws" && t.text.includes("\n")) break;
    if (t.kind === "comment") out.push(t.text);
  }
  return out;
}

const kindOf = (node: CreateNode): ObjectKind =>
  node.statement === "view" ? (node.materialized ? "materializedView" : "view") : node.statement;

const stringValue = (s: string | undefined) =>
  s === undefined ? undefined : /^'.*'$/s.test(s) ? s.slice(1, -1).replace(/''/g, "'").replace(/\\(.)/g, "$1") : s;

/**
 * Parse a CREATE statement into its canonical form. `defaultDatabase` is the
 * database an unqualified name is created in.
 */
export function canonicalObject(ddl: string, defaultDatabase = "default"): CanonicalObject {
  const tokens = tokenizeText(ddl, 0);
  const node = parseCreate(tokens);
  const nameParts = tokens
    .slice(node.name.from, node.name.to)
    .filter((t) => !isTrivia(t) && !(t.kind === "punct" && t.text === "."))
    .map((t) => unquote(t.text));
  const kind = kindOf(node);
  const name = nameParts[nameParts.length - 1]!;
  const database = kind === "database" || kind === "function" ? undefined : nameParts.length >= 2 ? nameParts[nameParts.length - 2] : defaultDatabase;
  const expr = (span: Span | undefined) => {
    const t = spanText(tokens, span);
    return t === undefined ? undefined : canonicalExpression(t, database);
  };
  const leading = tokens.slice(0, tokens.findIndex((t) => !isTrivia(t))).filter((t) => t.kind === "comment").map((t) => t.text);

  const obj: CanonicalObject = {
    kind,
    ...(database !== undefined ? { database } : {}),
    name,
    columns: [],
    settings: {},
    indexes: {},
    projections: {},
    constraints: {},
  };
  const previously = previouslyIn(leading);
  if (previously) obj.previously = previously;

  const comment0 = stringValue(spanText(tokens, node.comment));
  if (node.statement === "dictionary") {
    if (comment0 !== undefined && comment0 !== "") obj.comment = comment0;
    return dictionaryObject(obj, tokens, node, database);
  }
  if (node.statement === "function") {
    obj.lambda = canonicalExpression(spanText(tokens, node.lambda) ?? "");
    return obj;
  }

  const engine = node.engine;
  if (engine) {
    let args = engine.args?.map((a) => canonicalExpression(spanText(tokens, a) ?? "", database)) ?? [];
    // `ENGINE = ReplicatedMergeTree` with no Keeper path and replica name is
    // printed back with the server's defaults filled in; the two say the same.
    if (/^Replicated.*MergeTree$/.test(engine.name) && args[0] === DEFAULT_REPLICA_PATH && args[1] === DEFAULT_REPLICA_NAME) args = args.slice(2);
    // ClickHouse Cloud turns a declared MergeTree-family engine into its
    // `Shared*` one and prints it back with the path and replica it chose
    // (#3645, `../topology.ts`): the declaration said the plain family.
    let name = engine.name;
    const shared = /^Shared(\w*MergeTree)$/.exec(name);
    if (shared) {
      name = shared[1]!;
      if (/^'.*'$/s.test(args[0] ?? "") && /^'.*'$/s.test(args[1] ?? "")) args = args.slice(2);
    }
    // `Distributed(cluster, db, table, ...)` takes its first three arguments
    // as identifiers or as strings, and the server prints them back quoted
    // (#3664): an unquoted declaration says the same.
    if (name === "Distributed") args = args.map((a, i) => (i < 3 ? quotedIdentifier(a) : a));
    obj.engineName = name;
    obj.engine = args.length ? `${name}(${args.join(", ")})` : name;
  }
  if (comment0 !== undefined && comment0 !== "") obj.comment = comment0;

  if (node.statement === "database") {
    for (const s of node.settings ?? []) obj.settings[s.key] = canonicalExpression(spanText(tokens, s.value) ?? "").replace(/^'(.*)'$/, "$1");
    return obj;
  }

  const set = (k: "orderBy" | "primaryKey" | "partitionBy" | "sampleBy", span: Span | undefined) => {
    const v = expr(span);
    if (v !== undefined && v !== "") obj[k] = v;
  };
  set("orderBy", node.orderBy);
  set("primaryKey", node.primaryKey);
  set("partitionBy", node.partitionBy);
  set("sampleBy", node.sampleBy);
  if (node.ttl) obj.ttl = canonicalTtl(spanText(tokens, node.ttl)!, database);
  for (const s of node.settings ?? []) {
    const value = canonicalExpression(spanText(tokens, s.value) ?? "").replace(/^'(.*)'$/, "$1");
    const def = (MERGE_TREE_SETTINGS as Record<string, { default: string } | undefined>)[s.key];
    if (def && def.default === value) continue;
    obj.settings[s.key] = value;
  }

  if (node.statement === "table") {
    node.columns.forEach((c, i) => obj.columns.push(column(tokens, c, i, database)));
    for (const ix of node.indexes) {
      obj.indexes[ix.name] = [expr(ix.expr), "TYPE", expr(ix.type), ix.granularity ? `GRANULARITY ${expr(ix.granularity)}` : ""]
        .filter(Boolean)
        .join(" ");
    }
    for (const p of node.projections) obj.projections[p.name] = expr(p.body) ?? "";
    for (const c of node.constraints) obj.constraints[c.name] = `${c.kind} ${expr(c.expr)}`;
    return obj;
  }

  obj.select = expr(node.select);
  if (node.to) obj.to = qualified(tokens, node.to, defaultDatabase);
  if (node.refresh) obj.refresh = expr(node.refresh);
  return obj;
}

// ── dictionaries ──────────────────────────────────────────────────────

/**
 * A dictionary's clause (`SOURCE`, `LAYOUT`) as the server prints it: each
 * function name and each key upper case (`clickhouse(table 'r')` is
 * `CLICKHOUSE(TABLE 'r')`), each value as written, and a `PASSWORD` value
 * as `'[HIDDEN]'`, since `SHOW CREATE` never prints it.
 */
export function canonicalDictionaryClause(text: string): string {
  let sig: Token[];
  try {
    sig = tokenizeText(text, 0).filter((t) => !isTrivia(t));
  } catch {
    return text.trim();
  }
  const out: string[] = [];
  let key = true;
  let hide = false;
  for (let i = 0; i < sig.length; i++) {
    const t = sig[i]!;
    const next = sig[i + 1];
    if (t.kind === "punct" && (t.text === "(" || t.text === "," || t.text === ")")) {
      out.push(t.text);
      key = true;
      continue;
    }
    if (key && t.kind === "ident") {
      const word = t.text.toUpperCase();
      out.push(word);
      // A function name opens its own list of keys; a key is followed by its value.
      key = next?.kind === "punct" && next.text === "(";
      hide = word === "PASSWORD";
      continue;
    }
    out.push(hide ? "'[HIDDEN]'" : t.kind === "qident" ? unquote(t.text) : t.text);
    hide = false;
    key = !(next?.kind === "punct" && next.text === "(");
  }
  return out.join(" ");
}

/** `300` is `MIN 0 MAX 300`; `MAX b MIN a` is `MIN a MAX b`. */
export function canonicalLifetime(text: string): string {
  const words = canonicalExpression(text).split(" ");
  if (words.length === 1) return `MIN 0 MAX ${words[0]}`;
  const at = (w: string) => words.findIndex((x) => x.toUpperCase() === w);
  const min = at("MIN");
  const max = at("MAX");
  if (min < 0 || max < 0) return words.join(" ");
  return `MIN ${words[min + 1] ?? ""} MAX ${words[max + 1] ?? ""}`;
}

/** A key list with any parentheses around the whole of it left out: `(a, b)` is `a , b`. */
function keyList(text: string, database?: string): string {
  const e = canonicalExpression(text, database);
  if (!e.startsWith("( ") || !e.endsWith(" )")) return e;
  let depth = 0;
  const words = e.split(" ");
  for (let i = 0; i < words.length; i++) {
    if (words[i] === "(") depth++;
    else if (words[i] === ")") depth--;
    if (depth === 0 && i < words.length - 1) return e;
  }
  return words.slice(1, -1).join(" ");
}

function dictionaryAttribute(tokens: Token[], a: DictionaryAttributeNode, position: number, database?: string): CanonicalColumn {
  const text = (span: Span | undefined) => spanText(tokens, span);
  const out: CanonicalColumn = { name: a.name, position, type: canonicalType(text(a.type)!), text: [a.name, text(a.type)].join(" ") };
  const d = text(a.default);
  if (d !== undefined) {
    out.defaultKind = "DEFAULT";
    out.defaultExpr = canonicalExpression(d, database);
  }
  const e = text(a.expression);
  if (e !== undefined) out.expression = canonicalExpression(e, database);
  if (a.flags.length > 0) out.flags = [...a.flags].sort().join(" ");
  const prev = previouslyIn(lineComments(tokens, a.nameSpan.from));
  if (prev) out.previously = prev;
  return out;
}

function dictionaryObject(obj: CanonicalObject, tokens: Token[], node: DictionaryNode, database?: string): CanonicalObject {
  const text = (span: Span | undefined) => spanText(tokens, span);
  node.attributes.forEach((a, i) => obj.columns.push(dictionaryAttribute(tokens, a, i, database)));
  const pk = text(node.primaryKey);
  if (pk !== undefined) obj.primaryKey = keyList(pk, database);
  const source = text(node.source);
  if (source !== undefined) obj.dataSource = canonicalDictionaryClause(source);
  const layout = text(node.layout);
  if (layout !== undefined) obj.layout = canonicalDictionaryClause(layout);
  const lifetime = text(node.lifetime);
  if (lifetime !== undefined) obj.lifetime = canonicalLifetime(lifetime);
  const range = text(node.range);
  if (range !== undefined) obj.range = canonicalExpression(range, database).replace(/\b(min|max)\b/gi, (w) => w.toUpperCase());
  const settings = text(node.settings);
  if (settings !== undefined) {
    for (const item of splitTop(canonicalExpression(settings))) {
      const m = /^(\S+) = (.*)$/.exec(item);
      if (m) obj.settings[m[1]!] = m[2]!.replace(/^'(.*)'$/, "$1");
    }
  }
  return obj;
}

function qualified(tokens: Token[], span: Span, defaultDatabase: string): string {
  const parts = tokens
    .slice(span.from, span.to)
    .filter((t) => !isTrivia(t) && !(t.kind === "punct" && t.text === "."))
    .map((t) => unquote(t.text));
  return parts.length >= 2 ? `${parts[parts.length - 2]}.${parts[parts.length - 1]}` : `${defaultDatabase}.${parts[0]}`;
}

function column(tokens: Token[], c: ColumnNode, position: number, database?: string): CanonicalColumn {
  const text = (span: Span | undefined) => spanText(tokens, span);
  const out: CanonicalColumn = {
    name: c.name,
    position,
    type: c.type ? canonicalType(text(c.type)!) : "",
    text: [c.name, text(c.type)].filter(Boolean).join(" "),
  };
  if (c.nullable !== undefined) out.nullable = c.nullable;
  if (c.default) {
    out.defaultKind = c.default.kind;
    const e = text(c.default.expr);
    if (e !== undefined) out.defaultExpr = canonicalExpression(e, database);
  }
  if (c.codec) out.codec = canonicalCodec(text(c.codec)!);
  if (c.ttl) out.ttl = canonicalExpression(text(c.ttl)!, database);
  const comment = stringValue(text(c.comment));
  if (comment !== undefined && comment !== "") out.comment = comment;
  const prev = previouslyIn(lineComments(tokens, c.nameSpan.from));
  if (prev) out.previously = prev;
  return out;
}

/** A bare or backquoted identifier as the string literal the server prints it as; anything else as it is. */
function quotedIdentifier(arg: string): string {
  const bare = /^[A-Za-z_][A-Za-z0-9_]*$/.test(arg) ? arg : /^`((?:[^`]|``)+)`$/.exec(arg)?.[1]?.replace(/``/g, "`");
  return bare === undefined ? arg : `'${bare.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
}

/**
 * The key an object is compared under against a server: `database.name`,
 * a database's name, and `function <name>` for a function, which belongs to
 * no database and must not meet a database of the same name.
 */
export function objectKey(o: { kind?: ObjectKind; type?: string; database?: string; name: string }): string {
  if (o.kind === "function" || o.type === "ClickHouse::Function") return `function ${o.name}`;
  return o.database !== undefined ? `${o.database}.${o.name}` : o.name;
}

/**
 * What an object is scoped by when a plan reads a server: its database, a
 * database's own name, and for a function its key. A plan reads the
 * databases the declarations use and the functions they declare, nothing
 * else.
 */
export function scopeOf(o: { kind?: ObjectKind; type?: string; database?: string; name: string }): string {
  if (o.kind === "function" || o.type === "ClickHouse::Function") return objectKey(o);
  return o.database ?? o.name;
}
