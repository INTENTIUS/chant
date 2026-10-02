/**
 * Reading the ClickHouse objects in the sql build output for post-synth
 * checks: typed views of the serialized objects and a few scanners for the
 * expression text the parser keeps as written (sort keys, TTLs, index
 * expressions). The scanners are deliberately small: they answer "is this a
 * bare column name" and "which names does this expression mention", not "what
 * does this expression evaluate to".
 */

import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
import { TABLE_ENGINES, TYPE_FAMILIES } from "../../generated/clickhouse";
import type { ColumnDef, EngineDef } from "../../clickhouse/entities";
import { clickhouseObjects, type OutputObject } from "./sql-helpers";

export interface TableObject extends OutputObject {
  columns: ColumnDef[];
  indexes: Array<{ name: string; expr: string; type: string; granularity?: string }>;
  constraints: Array<{ name: string; kind: "CHECK" | "ASSUME"; expr: string }>;
  orderBy?: string;
  primaryKey?: string;
  partitionBy?: string;
  sampleBy?: string;
  ttl?: string;
  settings?: Record<string, string>;
  orReplace?: boolean;
}

export interface ViewObject extends OutputObject {
  columns: ColumnDef[];
  to?: string;
  select: string;
  lineage: Array<{ output: string; expr: string; from: Array<string | null> }>;
  security?: string;
}

export const isTable = (o: OutputObject): o is TableObject => o.type === "ClickHouse::Table";
export const isMaterializedView = (o: OutputObject): o is ViewObject => o.type === "ClickHouse::MaterializedView";
export const isAnyView = (o: OutputObject): o is ViewObject =>
  o.type === "ClickHouse::View" || o.type === "ClickHouse::MaterializedView";

export function tablesOf(ctx: PostSynthContext): TableObject[] {
  return clickhouseObjects(ctx).filter(isTable);
}

export function viewsOf(ctx: PostSynthContext): ViewObject[] {
  return clickhouseObjects(ctx).filter(isAnyView);
}

/** The engine's catalog entry, when the pinned server has the engine. */
export function engineSpec(engine: EngineDef | undefined) {
  return engine ? (TABLE_ENGINES as Record<string, (typeof TABLE_ENGINES)[keyof typeof TABLE_ENGINES]>)[engine.name] : undefined;
}

/** A MergeTree family engine, replicated or not. */
export function isMergeTree(engine: EngineDef | undefined): boolean {
  return engineSpec(engine)?.mergeTree === true;
}

/** The engine without its `Replicated` prefix: `ReplicatedReplacingMergeTree` is `ReplacingMergeTree`. */
export function baseEngineName(engine: EngineDef): string {
  const spec = engineSpec(engine) as { replicates?: string } | undefined;
  return spec?.replicates ?? engine.name;
}

/**
 * The engine's own arguments, after the ZooKeeper path and replica name a
 * `Replicated*` engine may lead with.
 */
export function engineArguments(engine: EngineDef): string[] {
  const args = engine.args ?? [];
  if (baseEngineName(engine) !== engine.name && args.length >= 2 && /^['{]/.test(args[0]!.trim())) return args.slice(2);
  return args;
}

/** Split on commas that are not inside parentheses, brackets or quotes. */
export function splitTop(text: string, separator = ","): string[] {
  const parts: string[] = [];
  let depth = 0;
  let quote: string | undefined;
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (quote) {
      if (c === "\\") i++;
      else if (c === quote) quote = undefined;
      continue;
    }
    if (c === "'" || c === '"' || c === "`") quote = c;
    else if (c === "(" || c === "[") depth++;
    else if (c === ")" || c === "]") depth--;
    else if (c === separator && depth === 0) {
      parts.push(text.slice(start, i).trim());
      start = i + 1;
    }
  }
  const last = text.slice(start).trim();
  if (last !== "" || parts.length > 0) parts.push(last);
  return parts.filter((p) => p !== "");
}

/** `(a, b)` is the list `a`, `b`; `a, b` is the same; `tuple()` and `()` are empty. */
export function keyElements(expr: string): string[] {
  let text = expr.trim();
  if (/^tuple\s*\(\s*\)$/i.test(text) || text === "()") return [];
  if (text.startsWith("(") && closingParen(text, 0) === text.length - 1) text = text.slice(1, -1);
  return splitTop(text).map((e) => e.replace(/\s+(ASC|DESC)$/i, "").replace(/\s+/g, " ").trim());
}

function closingParen(text: string, open: number): number {
  let depth = 0;
  let quote: string | undefined;
  for (let i = open; i < text.length; i++) {
    const c = text[i]!;
    if (quote) {
      if (c === "\\") i++;
      else if (c === quote) quote = undefined;
    } else if (c === "'" || c === '"' || c === "`") quote = c;
    else if (c === "(") depth++;
    else if (c === ")" && --depth === 0) return i;
  }
  return -1;
}

/** The column a bare name refers to: `a` or `` `a b` ``, else undefined. */
export function bareName(element: string): string | undefined {
  const text = element.trim();
  if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(text)) return text;
  const quoted = /^`((?:[^`]|``)*)`$/.exec(text) ?? /^"((?:[^"]|"")*)"$/.exec(text);
  return quoted ? quoted[1]!.replace(/``|""/g, (m) => m[0]!) : undefined;
}

const WORDS = new Set(
  (
    "AS AND OR NOT IN IS NULL LIKE ILIKE BETWEEN CASE WHEN THEN ELSE END ASC DESC INTERVAL DISTINCT TRUE FALSE " +
    "SECOND MINUTE HOUR DAY WEEK MONTH QUARTER YEAR NANOSECOND MICROSECOND MILLISECOND CAST"
  ).split(" "),
);

/** Names an expression mentions as columns: identifiers that are not calls, literals or keywords. */
export function mentionedNames(expr: string): string[] {
  const names: string[] = [];
  const re = /'(?:[^'\\]|\\.)*'|`((?:[^`]|``)*)`|"((?:[^"]|"")*)"|\b([A-Za-z_][A-Za-z0-9_]*)\b(\s*\()?|\d[\w.]*/g;
  let m: RegExpExecArray | null;
  let afterDot = false;
  let last = 0;
  while ((m = re.exec(expr)) !== null) {
    afterDot = /\.\s*$/.test(expr.slice(last, m.index));
    last = m.index + m[0].length;
    const name = m[1] ?? m[2] ?? m[3];
    if (name === undefined || m[4] !== undefined || afterDot) continue;
    if (m[3] !== undefined && WORDS.has(m[3].toUpperCase())) continue;
    names.push(name.replace(/``|""/g, (x) => x[0]!));
  }
  return names;
}

/** A type with its `Nullable(...)` and `LowCardinality(...)` wrappers removed. */
export function unwrapType(type: string | undefined): string {
  let t = (type ?? "").trim();
  for (;;) {
    const m = /^(Nullable|LowCardinality)\s*\(([\s\S]*)\)$/i.exec(t);
    if (!m) return t;
    t = m[2]!.trim();
  }
}

/** The canonical family of a column's type (`BIGINT UNSIGNED` is `UInt64`), or its leading word when unknown. */
export function typeFamily(type: string | undefined): string {
  const head = /^[A-Za-z_][A-Za-z0-9_ ]*?(?=\s*\(|$)/.exec(unwrapType(type))?.[0]?.trim() ?? "";
  const table = TYPE_FAMILIES as Record<string, { canonical: string } | undefined>;
  return (table[head] ?? table[head.toUpperCase()])?.canonical ?? head;
}

export const isNullableType = (type: string | undefined): boolean => /^Nullable\s*\(/i.test((type ?? "").trim());

export function columnByName(table: { columns: ColumnDef[] }, name: string): ColumnDef | undefined {
  return table.columns.find((c) => c.name === name);
}

/** A check over the build's ClickHouse objects, so each check file holds its rule. */
export function checkOf(
  meta: { id: string; description: string },
  run: (ctx: PostSynthContext, report: (d: Omit<PostSynthDiagnostic, "checkId" | "lexicon">) => void) => void,
): PostSynthCheck {
  return {
    ...meta,
    check(ctx) {
      const out: PostSynthDiagnostic[] = [];
      run(ctx, (d) => out.push({ checkId: meta.id, lexicon: "sql", ...d }));
      return out;
    },
  };
}

/** The objects by export name and by SQL name, to resolve a `TO` target. */
export function resolveObject(ctx: PostSynthContext, ref: string): OutputObject | undefined {
  const all = clickhouseObjects(ctx);
  return all.find((o) => o.export === ref) ?? all.find((o) => o.sqlName === ref || o.name === ref);
}

/** The codec names in a CODEC(...) list: `Delta, ZSTD(3)` is Delta and ZSTD. */
export function codecNames(codec: string): string[] {
  return splitTop(codec)
    .map((c) => /^[A-Za-z_][\w]*/.exec(c.trim())?.[0])
    .filter((n): n is string => n !== undefined);
}
