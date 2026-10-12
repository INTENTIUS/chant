/**
 * `@intentius/chant-lexicon-sql/read`: a typed, read-only view of the SQL
 * objects a build declares (#3870), for a project's own `lint.policies`.
 *
 * A policy's `check(ctx)` gets the build's parsed output in `ctx.docs`.
 * {@link readPostgres} and {@link readClickHouse} turn the sql lexicon's part
 * of it into tables with typed columns (SQL type, nullability, default,
 * comment), keys, indexes and engines, and views with their outputs and
 * column lineage. The lexicon's own post-synth checks read the same values,
 * so a project rule sees exactly what `SQLPG101` or `SQLCH113` sees.
 *
 * ```ts
 * import type { PostSynthCheck } from "@intentius/chant/lint/post-synth";
 * import { canonicalPostgresType, readPostgres } from "@intentius/chant-lexicon-sql/read";
 *
 * const TIMESTAMPTZ = canonicalPostgresType("timestamptz");
 *
 * export const createdAt: PostSynthCheck = {
 *   id: "ORG-CREATED-AT",
 *   description: "every table has created_at timestamptz NOT NULL",
 *   check(ctx) {
 *     return readPostgres(ctx).tables
 *       .filter((t) => { const c = t.column("created_at"); return !c || c.typeName !== TIMESTAMPTZ || c.nullable; })
 *       .map((t) => ({ checkId: "ORG-CREATED-AT", severity: "error", entity: t.export,
 *                      message: `${t.qualifiedName} needs created_at timestamptz NOT NULL` }));
 *   },
 * };
 * ```
 *
 * Every value keeps the fields the serializer writes (see the Serialization
 * page) and adds the derived ones documented on each type. The reads also take
 * the serialized document itself (`{ dialect, objects }`), for a tool that
 * holds a recorded build rather than a post-synth context.
 */

export { readPostgres, canonicalPostgresType } from "./read/postgres";
export type { PostgresRead, PostgresTableInfo, PostgresColumnInfo, PostgresIndexInfo, PostgresViewInfo } from "./read/postgres";
export { readClickHouse } from "./read/clickhouse";
export type { ClickHouseRead, ClickHouseTableInfo, ClickHouseColumnInfo, ClickHouseViewInfo } from "./read/clickhouse";
export { sqlDocuments, isSqlOutputDocument } from "./read/objects";
export type {
  SqlReadSource,
  SqlOutputDocument,
  SqlObjectBase,
  SqlObjectJson,
  RefJson,
  LineageJson,
  PostgresTableJson,
  PostgresIndexJson,
  PostgresViewJson,
  PostgresForeignKeyJson,
  ClickHouseTableJson,
  ClickHouseViewJson,
} from "./read/objects";

import { readClickHouse, type ClickHouseRead } from "./read/clickhouse";
import { readPostgres, type PostgresRead } from "./read/postgres";
import { sqlDocuments, type SqlOutputDocument, type SqlReadSource } from "./read/objects";

/**
 * The build's SQL objects in whichever dialect it declares: one build holds
 * one dialect. Undefined when the build has no sql output.
 */
export function readSql(source: SqlReadSource | SqlOutputDocument): PostgresRead | ClickHouseRead | undefined {
  const dialect = "objects" in source ? source.dialect : sqlDocuments(source)[0]?.dialect;
  if (dialect === "postgres") return readPostgres(source);
  if (dialect === "clickhouse") return readClickHouse(source);
  return undefined;
}
