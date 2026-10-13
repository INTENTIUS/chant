/**
 * Reading the ClickHouse objects in the sql build output for post-synth
 * checks: typed views of the serialized objects and a few scanners for the
 * expression text the parser keeps as written (sort keys, TTLs, index
 * expressions). The scanners are deliberately small: they answer "is this a
 * bare column name" and "which names does this expression mention", not "what
 * does this expression evaluate to".
 */

import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
import type { ColumnDef, EngineDef } from "../../clickhouse/entities";
import { baseEngineName, splitTop } from "../../clickhouse/expressions";
import { readClickHouse, type ClickHouseTableInfo, type ClickHouseViewInfo } from "../../read/clickhouse";
import { clickhouseObjects, type OutputObject } from "./sql-helpers";

export {
  bareName,
  baseEngineName,
  engineSpec,
  isMergeTree,
  isNullableType,
  keyElements,
  splitTop,
  typeFamily,
  unwrapType,
} from "../../clickhouse/expressions";

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

/** The build's tables as the public read API types them (`@intentius/chant-lexicon-sql/read`), so a project policy reads what the checks read. */
export function tablesOf(ctx: PostSynthContext): ClickHouseTableInfo[] {
  return readClickHouse(ctx).tables;
}

/** The build's views and materialized views, as the public read API types them. */
export function viewsOf(ctx: PostSynthContext): ClickHouseViewInfo[] {
  return readClickHouse(ctx).views;
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
