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
import { parseCreate, unquote, type ColumnNode, type CreateNode, type Span } from "../parser";
import { MERGE_TREE_SETTINGS, TYPE_FAMILIES } from "../../generated/clickhouse";

export type ObjectKind = "database" | "table" | "view" | "materializedView";

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

/** Split canonical text on top-level commas. */
function splitTop(text: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let cur: string[] = [];
  for (const tok of text.split(" ")) {
    if (tok === "(" || tok === "[") depth++;
    if (tok === ")" || tok === "]") depth--;
    if (tok === "," && depth === 0) {
      parts.push(cur.join(" "));
      cur = [];
    } else cur.push(tok);
  }
  if (cur.length) parts.push(cur.join(" "));
  return parts.filter((p) => p.length > 0);
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

/** The name in a `-- previously: <name>` comment, when the text holds one. */
export function previouslyIn(comments: readonly string[]): string | undefined {
  for (const c of comments) {
    const m = /^--\s*previously\s*:\s*([`"]?)([^\s`"]+)\1\s*$/i.exec(c.trim());
    if (m) return m[2];
  }
  return undefined;
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
  node.statement === "database" ? "database" : node.statement === "table" ? "table" : node.materialized ? "materializedView" : "view";

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
  const database = kind === "database" ? undefined : nameParts.length >= 2 ? nameParts[nameParts.length - 2] : defaultDatabase;
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

  const engine = node.engine;
  if (engine) {
    const args = engine.args?.map((a) => canonicalExpression(spanText(tokens, a) ?? "", database)) ?? [];
    obj.engineName = engine.name;
    obj.engine = args.length ? `${engine.name}(${args.join(", ")})` : engine.name;
  }
  const comment = stringValue(spanText(tokens, node.comment));
  if (comment !== undefined && comment !== "") obj.comment = comment;

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
