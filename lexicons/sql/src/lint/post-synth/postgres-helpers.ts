/**
 * Reading the Postgres objects in the sql build output for post-synth checks:
 * typed views of the serialized objects and the small scanners the checks
 * share. Expressions are kept as written; the scanners answer narrow questions
 * ("is this a bare column"), not what an expression evaluates to.
 */

import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
import { POSTGRES_MAJORS, VERSION_RANGES } from "../../generated/postgres";
import type { VersionRange } from "../../postgres/catalog-types";
import type { ColumnDef, KeyDef } from "../../postgres/entities";
import { postgresObjects, type OutputObject } from "./sql-helpers";

export interface PgTable extends OutputObject {
  sqlName: string;
  like: string[];
  schema?: string;
  comment?: string;
  columns: Array<ColumnDef & { comment?: string }>;
  primaryKey?: KeyDef;
  uniques: KeyDef[];
  checks: Array<{ name?: string; expr: string; notEnforced?: boolean }>;
  foreignKeys: Array<{ name?: string; columns: string[]; refTable: string; refColumns: string[] }>;
  exclusions: unknown[];
  inherits: unknown[];
  partitionOf?: unknown;
  ofType?: unknown;
  persistence?: string;
  with?: string;
}

export interface PgIndex extends OutputObject {
  sqlName: string;
  schema?: string;
  table: string;
  tableName: string;
  unique?: boolean;
  method?: string;
  elements: Array<{ expr: string; column?: string }>;
  include?: string;
  where?: string;
  with?: string;
}

export interface PgView extends OutputObject {
  sqlName: string;
  schema?: string;
  query: string;
  with?: string;
}

export const isTable = (o: OutputObject): o is PgTable => o.type === "Postgres::Table";
export const isIndex = (o: OutputObject): o is PgIndex => o.type === "Postgres::Index";
export const isView = (o: OutputObject): o is PgView => o.type === "Postgres::View";
export const isMaterializedView = (o: OutputObject): o is PgView => o.type === "Postgres::MaterializedView";

export const tablesOf = (ctx: PostSynthContext): PgTable[] => postgresObjects(ctx).filter(isTable);
export const indexesOf = (ctx: PostSynthContext): PgIndex[] => postgresObjects(ctx).filter(isIndex);

/** The newest and oldest majors the lexicon carries a catalog for. */
export const PINNED_MAJOR: number = POSTGRES_MAJORS[POSTGRES_MAJORS.length - 1]!;
export const OLDEST_MAJOR: number = POSTGRES_MAJORS[0]!;

/** The version range the generated catalog records for `name` in `table`, if it is not in every major. */
export function rangeOf(table: keyof typeof VERSION_RANGES, name: string): VersionRange | undefined {
  return (VERSION_RANGES[table] as Record<string, VersionRange | undefined>)[name];
}

/** A column type's leading words, lower-cased, without a length or array suffix: `timestamp(3)[]` is `timestamp`. */
export function baseType(type: string | undefined): string {
  return (type ?? "").toLowerCase().replace(/\[.*$/, "").replace(/\(.*?\)/g, "").replace(/\s+/g, " ").trim();
}

/** The `name = value` pairs of a `(a = 1, b)` storage parameter list, names lower-cased. */
export function storageParams(text: string | undefined): Map<string, string> {
  const out = new Map<string, string>();
  const inner = (text ?? "").trim().replace(/^\(/, "").replace(/\)$/, "");
  for (const part of inner.split(",")) {
    const [k, ...v] = part.split("=");
    const name = k!.trim().toLowerCase();
    if (name) out.set(name, v.join("=").trim());
  }
  return out;
}

/** The leading bare-column elements of an index, in order; stops at the first expression. */
export function leadingColumns(index: PgIndex): string[] {
  const out: string[] = [];
  for (const e of index.elements) {
    if (!e.column) break;
    out.push(e.column);
  }
  return out;
}

/** A check over the build's Postgres objects, so each check file holds its rule. */
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

/** A table that owns its columns: not a partition, not typed (`OF type`), not temporary. */
export const ownsColumns = (t: PgTable): boolean => t.partitionOf === undefined && t.ofType === undefined && t.persistence !== "temporary";

/** The catalog's relation kind for a storage-parameter list on this object, as `STORAGE_PARAMETERS.targets` spells it. */
export function storageTarget(o: OutputObject): string | undefined {
  switch (o.type) {
    case "Postgres::Table": return "table";
    case "Postgres::View": return "view";
    case "Postgres::MaterializedView": return "materialized view";
    case "Postgres::Index": return `index:${(o.method as string | undefined) ?? "btree"}`;
    default: return undefined;
  }
}
