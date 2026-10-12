/**
 * The ClickHouse half of the public read API (`../read.ts`): the build's
 * tables, columns, sort keys, skip indexes, engines and views as typed values,
 * built from the serialized output. The lexicon's post-synth checks read the
 * same values (`../lint/post-synth/clickhouse-helpers.ts`).
 */

import { relationKey } from "../core/typed";
import type { ColumnDef } from "../clickhouse/entities";
import { bareName, baseEngineName, isMergeTree, isNullableType, keyElements, typeFamily, unwrapType } from "../clickhouse/expressions";
import { dialectObjects, type ClickHouseTableJson, type ClickHouseViewJson, type SqlObjectJson, type SqlReadSource } from "./objects";

/** A column of a ClickHouse table or view, as declared, with what follows from the declaration. */
export interface ClickHouseColumnInfo extends ColumnDef {
  /** Whether the column can hold NULL: its type is `Nullable(...)` (inside `LowCardinality` too), or it is declared `NULL`. */
  nullable: boolean;
  /** `LowCardinality(...)`. */
  lowCardinality: boolean;
  /** The type without its `Nullable` and `LowCardinality` wrappers, as written: `DateTime64(3, 'UTC')`. */
  baseType?: string;
  /** The type family's canonical name, as the pinned server's catalog has it: `BIGINT UNSIGNED` is `UInt64`, `DateTime64(3)` is `DateTime64`. */
  family?: string;
  /** A bare element of the table's sort key (`ORDER BY`). */
  inSortKey: boolean;
}

/** A ClickHouse table, as declared: its columns, engine, keys and skip indexes. */
export interface ClickHouseTableInfo extends Omit<ClickHouseTableJson, "columns"> {
  /** `database.name` when the DDL qualifies it, else the name: the table's key in `SqlSchema`. */
  qualifiedName: string;
  columns: ClickHouseColumnInfo[];
  /** The engine without a `Replicated` prefix: `ReplicatedReplacingMergeTree` is `ReplacingMergeTree`. */
  engineFamily?: string;
  /** A MergeTree family engine, replicated or not. */
  mergeTree: boolean;
  /** The `ORDER BY` elements, as written, without `ASC`/`DESC`; empty for `tuple()` or none. */
  sortKey: string[];
  /** The `PRIMARY KEY` elements, else the sort key's, which is what ClickHouse uses when none is written. */
  primaryKeyElements: string[];
  /** The column named `name`, if the table declares one. */
  column(name: string): ClickHouseColumnInfo | undefined;
}

/** A view or materialized view, with the names of its output columns. */
export interface ClickHouseViewInfo extends Omit<ClickHouseViewJson, "columns"> {
  qualifiedName: string;
  materialized: boolean;
  columns: ClickHouseColumnInfo[];
  /** The declared columns, else the outputs of the query's select list. */
  outputs: string[];
}

/** What a ClickHouse build declares. */
export interface ClickHouseRead {
  dialect: "clickhouse";
  tables: ClickHouseTableInfo[];
  views: ClickHouseViewInfo[];
  /** Every serialized object, databases, dictionaries, users and grants included, in apply order. */
  objects: SqlObjectJson[];
  /** A table by export name, `database.name`, or name. */
  table(ref: string): ClickHouseTableInfo | undefined;
}

function columnInfo(c: ColumnDef, sortKey: ReadonlySet<string>): ClickHouseColumnInfo {
  const inner = /^LowCardinality\s*\(/i.test((c.type ?? "").trim());
  const nullable = c.nullable === true || isNullableType(c.type) || (inner && isNullableType(unwrapLowCardinality(c.type!)));
  return {
    ...c,
    nullable,
    lowCardinality: inner,
    ...(c.type !== undefined ? { baseType: unwrapType(c.type), family: typeFamily(c.type) } : {}),
    inSortKey: sortKey.has(c.name),
  };
}

function unwrapLowCardinality(type: string): string {
  return type.trim().replace(/^LowCardinality\s*\(([\s\S]*)\)$/i, "$1").trim();
}

function build(objects: SqlObjectJson[]): ClickHouseRead {
  const tables = objects
    .filter((o) => o.type === "ClickHouse::Table")
    .map((o): ClickHouseTableInfo => {
      const t = o as unknown as ClickHouseTableJson;
      const sortKey = t.orderBy ? keyElements(t.orderBy) : [];
      const bare = new Set(sortKey.map(bareName).filter((n): n is string => n !== undefined));
      const columns = (t.columns ?? []).map((c) => columnInfo(c, bare));
      return {
        ...t,
        qualifiedName: relationKey(t),
        columns,
        ...(t.engine ? { engineFamily: baseEngineName(t.engine) } : {}),
        mergeTree: isMergeTree(t.engine),
        sortKey,
        primaryKeyElements: t.primaryKey ? keyElements(t.primaryKey) : sortKey,
        column: (name) => columns.find((c) => c.name === name),
      };
    });
  const views = objects
    .filter((o) => o.type === "ClickHouse::View" || o.type === "ClickHouse::MaterializedView")
    .map((o): ClickHouseViewInfo => {
      const v = o as unknown as ClickHouseViewJson;
      const columns = (v.columns ?? []).map((c) => columnInfo(c, new Set()));
      return {
        ...v,
        qualifiedName: relationKey(v),
        materialized: v.type === "ClickHouse::MaterializedView",
        columns,
        outputs: columns.length > 0 ? columns.map((c) => c.name) : (v.lineage ?? []).map((e) => e.output),
      };
    });
  return {
    dialect: "clickhouse",
    tables,
    views,
    objects,
    table: (ref) => tables.find((t) => t.export === ref) ?? tables.find((t) => t.qualifiedName === ref) ?? tables.find((t) => t.name === ref),
  };
}

const cache = new WeakMap<object, ClickHouseRead>();

/**
 * What a ClickHouse build declares, read from a post-synth context's `docs`
 * (a `lint.policies` check's `ctx`), or from the serialized output document
 * itself. Empty when the build has no ClickHouse output. The result is cached
 * per context; treat it as read-only.
 */
export function readClickHouse(source: SqlReadSource | { dialect: string; objects: unknown[] }): ClickHouseRead {
  if ("objects" in source) return build(source.dialect === "clickhouse" ? (source.objects as SqlObjectJson[]) : []);
  const key = source.docs;
  const hit = key ? cache.get(key) : undefined;
  if (hit) return hit;
  const read = build(dialectObjects(source, "clickhouse"));
  if (key) cache.set(key, read);
  return read;
}
