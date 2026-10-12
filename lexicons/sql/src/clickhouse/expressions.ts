/**
 * Small scanners over ClickHouse expression text as the parser keeps it
 * (sort keys, engine arguments, column types), shared by the post-synth
 * checks (`../lint/post-synth/clickhouse-helpers.ts`) and the public read API
 * (`../read/clickhouse.ts`). They answer narrow questions ("is this a bare
 * column name", "what family is this type"), not what an expression
 * evaluates to.
 */

import { TABLE_ENGINES, TYPE_FAMILIES } from "../generated/clickhouse";
import type { EngineDef } from "./entities";

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

