/**
 * Reading the Postgres objects in the sql build output for post-synth checks:
 * typed views of the serialized objects and the small scanners the checks
 * share. Expressions are kept as written; the scanners answer narrow questions
 * ("is this a bare column"), not what an expression evaluates to.
 */

import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
import { POSTGRES_MAJORS, VERSION_RANGES } from "../../generated/postgres";
import type { VersionRange } from "../../postgres/catalog-types";
import { readPostgres, type PostgresIndexInfo, type PostgresTableInfo, type PostgresViewInfo } from "../../read/postgres";
import type { PostgresIndexJson, PostgresTableJson, PostgresViewJson } from "../../read/objects";
import { postgresMajorOf, type OutputObject } from "./sql-helpers";

/**
 * The objects as the public read API types them (`../../read/postgres.ts`,
 * `@intentius/chant-lexicon-sql/read`): the checks and a project's own
 * `lint.policies` read the same values.
 */
export type PgTable = PostgresTableInfo;
export type PgIndex = PostgresIndexInfo;
export type PgView = PostgresViewInfo;

export const isTable = (o: OutputObject): o is OutputObject & PostgresTableJson => o.type === "Postgres::Table";
export const isIndex = (o: OutputObject): o is OutputObject & PostgresIndexJson => o.type === "Postgres::Index";
export const isView = (o: OutputObject): o is OutputObject & PostgresViewJson => o.type === "Postgres::View";
export const isMaterializedView = (o: OutputObject): o is OutputObject & PostgresViewJson => o.type === "Postgres::MaterializedView";

export const tablesOf = (ctx: PostSynthContext): PgTable[] => readPostgres(ctx).tables;
export const indexesOf = (ctx: PostSynthContext): PgIndex[] => readPostgres(ctx).indexes;

/** The major the build targets (`postgresMajor` in the output), else the newest pinned. */
export const targetMajor = (ctx: PostSynthContext): number => postgresMajorOf(ctx, PINNED_MAJOR);

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
export const leadingColumns = (index: PgIndex): string[] => index.columns;

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
