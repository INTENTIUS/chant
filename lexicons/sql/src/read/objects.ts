/**
 * The sql build output as the serializer writes it (`../serializer.ts`): one
 * JSON document per build with `dialect`, `applyOrder` and `objects`, each
 * object its entity's props with the template source dropped, the DDL moved
 * to the end, and every reference to another declared object written as that
 * object's export name.
 *
 * This is the one place that finds those documents in a post-synth context.
 * The public read API (`../read.ts`) and the lexicon's own post-synth checks
 * (`../lint/post-synth/sql-helpers.ts`) both start here.
 */

import type { OutputDoc } from "@intentius/chant/lint/post-synth";
import type * as ch from "../clickhouse/entities";
import type * as pg from "../postgres/entities";

/** What a reader takes: a post-synth context, or anything else carrying its `docs`. */
export interface SqlReadSource {
  readonly docs?: readonly OutputDoc[];
}

/** One build output document, as the serializer writes it. */
export interface SqlOutputDocument {
  dialect: "clickhouse" | "postgres";
  /** Postgres only: the major the build targets (`sql.postgresMajor`, else the newest pinned). */
  postgresMajor?: number;
  applyOrder?: string[];
  objects: SqlObjectJson[];
}

/** A reference to another declared object: its export name, or null when it is not one the build declares. */
export type RefJson = string | null;

/** The fields every serialized object has. */
export interface SqlObjectBase {
  /** The export name of the declaration. */
  export: string;
  /** The entity type: `Postgres::Table`, `ClickHouse::MaterializedView`, ... */
  type: string;
  /** The object's name in the database, unquoted. */
  name: string;
  /** The name it is referred to by in SQL: `name`, or `schema.name` / `database.name`. */
  sqlName?: string;
  /** The export names it must be created after. */
  dependsOn?: string[];
  /** The statements as they will be sent. */
  ddl?: string;
}

/** Any serialized object: the common fields, and the rest of its props as written. */
export interface SqlObjectJson extends SqlObjectBase {
  [key: string]: unknown;
}

type Serialized<P> = Omit<P, "source" | "ddl"> & Omit<SqlObjectBase, "type"> & { sqlName: string; dependsOn: string[]; ddl: string };

/** A lineage edge as written: the output column, its expression, and the `export.column` names it reads. */
export interface LineageJson {
  output: string;
  expr: string;
  from: Array<string | null>;
}

// ── Postgres ──────────────────────────────────────────────────────────

export interface PostgresForeignKeyJson extends Omit<pg.ForeignKeyDef, "references"> {
  /** The referenced table's export name, or null when the build does not declare it. */
  references: RefJson;
}

export interface PostgresTableJson
  extends Omit<Serialized<pg.TableProps>, "partitionOf" | "ofType" | "inherits" | "foreignKeys"> {
  type: "Postgres::Table";
  partitionOf?: RefJson;
  ofType?: RefJson;
  inherits: RefJson[];
  foreignKeys: PostgresForeignKeyJson[];
}

export interface PostgresIndexJson extends Omit<Serialized<pg.IndexProps>, "table"> {
  type: "Postgres::Index";
  /** The indexed table's export name, or null when the build does not declare it. */
  table: RefJson;
}

export interface PostgresViewJson extends Omit<Serialized<pg.ViewProps>, "reads" | "lineage"> {
  type: "Postgres::View" | "Postgres::MaterializedView";
  reads: RefJson[];
  lineage: LineageJson[];
}

// ── ClickHouse ────────────────────────────────────────────────────────

export interface ClickHouseTableJson extends Serialized<ch.TableProps> {
  type: "ClickHouse::Table";
}

export interface ClickHouseViewJson extends Omit<Serialized<ch.ViewProps>, "to" | "reads" | "lineage"> {
  type: "ClickHouse::View" | "ClickHouse::MaterializedView";
  /** A materialized view's target: its export name when declared, else the name as written. */
  to?: RefJson;
  reads: RefJson[];
  lineage: LineageJson[];
}

// ── Finding the documents ─────────────────────────────────────────────

/** True for a value shaped like the serializer's document. */
export function isSqlOutputDocument(value: unknown): value is SqlOutputDocument {
  const v = value as { dialect?: unknown; objects?: unknown } | null;
  return v !== null && typeof v === "object" && (v.dialect === "clickhouse" || v.dialect === "postgres") && Array.isArray(v.objects);
}

/** Every sql output document in the context, in output order. */
export function sqlDocuments(source: SqlReadSource): SqlOutputDocument[] {
  const out: SqlOutputDocument[] = [];
  for (const doc of source.docs ?? []) {
    if (doc.error || doc.lexicon !== "sql" || doc.format !== "json") continue;
    if (isSqlOutputDocument(doc.value)) out.push(doc.value);
  }
  return out;
}

/** Every serialized object of one dialect, across the context's sql documents. */
export function dialectObjects(source: SqlReadSource, dialect: SqlOutputDocument["dialect"]): SqlObjectJson[] {
  const out: SqlObjectJson[] = [];
  for (const doc of sqlDocuments(source)) if (doc.dialect === dialect) out.push(...doc.objects);
  return out;
}

/** The Postgres major the build output records, else `fallback`. */
export function recordedPostgresMajor(source: SqlReadSource, fallback: number): number {
  for (const doc of sqlDocuments(source)) {
    if (doc.dialect === "postgres" && typeof doc.postgresMajor === "number") return doc.postgresMajor;
  }
  return fallback;
}
