/**
 * The Postgres half of the public read API (`../read.ts`): the build's
 * tables, columns, keys, indexes and views as typed values, built from the
 * serialized output. The lexicon's post-synth checks read the same values
 * (`../lint/post-synth/postgres-helpers.ts`).
 */

import { POSTGRES_MAJORS } from "../generated/postgres";
import { relationKey } from "../core/typed";
import { parseType, projectFromObjects, resolveType, typeLabel, type PgProject } from "../lint/post-synth/postgres-names";
import {
  dialectObjects,
  recordedPostgresMajor,
  type PostgresIndexJson,
  type PostgresTableJson,
  type PostgresViewJson,
  type SqlObjectJson,
  type SqlReadSource,
} from "./objects";
import type { ColumnDef } from "../postgres/entities";

/** A column of a Postgres table, as declared, with what follows from the declaration. */
export interface PostgresColumnInfo extends ColumnDef {
  /**
   * Whether the column can hold NULL: false when it is `NOT NULL`, in the
   * primary key, an identity column or a `serial`, true otherwise.
   */
  nullable: boolean;
  /**
   * The type's canonical name, without modifiers or array brackets: a
   * built-in as Postgres's `format_type()` spells it (`timestamptz` is
   * `timestamp with time zone`, `int8` and `bigserial` are `bigint`), a type
   * the project declares by its SQL name, anything else as written, lower
   * case. Undefined when the column has no type of its own (a partition, a
   * typed table) or the type is not a plain name.
   */
  typeName?: string;
  /** `text[]`, `integer ARRAY`. */
  array: boolean;
  /** One of the primary key's columns. */
  inPrimaryKey: boolean;
}

/** A `CREATE INDEX`, with its table's export name and the columns it leads with. */
export interface PostgresIndexInfo extends PostgresIndexJson {
  /** The elements that are bare columns, in order, up to the first expression. */
  columns: string[];
}

/** A Postgres table, as declared: its columns, keys, constraints and the indexes declared on it. */
export interface PostgresTableInfo extends Omit<PostgresTableJson, "columns"> {
  /** `schema.name` when the DDL qualifies it, else the name: the table's key in `SqlSchema`. */
  qualifiedName: string;
  columns: PostgresColumnInfo[];
  /** The `CREATE INDEX` statements on this table (constraints' own indexes are `primaryKey` and `uniques`). */
  indexes: PostgresIndexInfo[];
  /** The column named `name`, if the table declares one. */
  column(name: string): PostgresColumnInfo | undefined;
}

/** A view or materialized view, with the names of its output columns. */
export interface PostgresViewInfo extends PostgresViewJson {
  qualifiedName: string;
  materialized: boolean;
  /** The declared column list, else the outputs of the query's select list. */
  outputs: string[];
}

/** What a Postgres build declares. */
export interface PostgresRead {
  dialect: "postgres";
  /** The major the build targets. */
  major: number;
  tables: PostgresTableInfo[];
  views: PostgresViewInfo[];
  indexes: PostgresIndexInfo[];
  /** Every serialized object, sequences, functions, roles and grants included, in apply order. */
  objects: SqlObjectJson[];
  /** A table by export name, `schema.name`, or name. */
  table(ref: string): PostgresTableInfo | undefined;
}

const PINNED_MAJOR: number = POSTGRES_MAJORS[POSTGRES_MAJORS.length - 1]!;

/** A column type's canonical name, array-ness and serial-ness against a project. */
function typeOf(p: PgProject, text: string | undefined): { typeName?: string; array: boolean; serial: boolean } {
  const t = parseType(text);
  if (!t) return { ...(text ? { typeName: text.trim().toLowerCase() } : {}), array: false, serial: false };
  const r = resolveType(p, t, { serial: true });
  const typeName =
    r.kind === "builtin" || r.kind === "absent" ? r.canonical : r.kind === "declared" ? String(r.object.sqlName ?? r.object.name) : typeLabel(t);
  return { typeName, array: t.array, serial: r.kind === "builtin" && r.serial === true };
}

/**
 * The canonical name of a Postgres type as written: `timestamptz` and
 * `TIMESTAMP WITH TIME ZONE` are both `timestamp with time zone`, `int4` is
 * `integer`. Compare a column's {@link PostgresColumnInfo.typeName} with it,
 * so a rule does not depend on how the DDL spelled the type.
 */
export function canonicalPostgresType(text: string): string | undefined {
  return typeOf(projectFromObjects([], PINNED_MAJOR), text).typeName;
}

function columnInfo(p: PgProject, c: ColumnDef, pk: ReadonlySet<string>): PostgresColumnInfo {
  const { typeName, array, serial } = typeOf(p, c.type);
  const inPrimaryKey = pk.has(c.name);
  const nullable = !(c.notNull === true || inPrimaryKey || c.generated?.kind === "identity" || serial);
  return { ...c, nullable, ...(typeName !== undefined ? { typeName } : {}), array, inPrimaryKey };
}

function indexInfo(i: PostgresIndexJson): PostgresIndexInfo {
  const columns: string[] = [];
  for (const e of i.elements ?? []) {
    if (!e.column) break;
    columns.push(e.column);
  }
  return { ...i, columns };
}

function build(objects: SqlObjectJson[], major: number): PostgresRead {
  const p = projectFromObjects(objects, major);
  const indexes = objects.filter((o) => o.type === "Postgres::Index").map((o) => indexInfo(o as unknown as PostgresIndexJson));
  const tables = objects
    .filter((o) => o.type === "Postgres::Table")
    .map((o): PostgresTableInfo => {
      const t = o as unknown as PostgresTableJson;
      const pk = new Set(t.primaryKey?.columns ?? []);
      const columns = (t.columns ?? []).map((c) => columnInfo(p, c, pk));
      return {
        ...t,
        qualifiedName: relationKey(t),
        columns,
        indexes: indexes.filter((i) => i.table === t.export || i.tableName === t.sqlName),
        column: (name) => columns.find((c) => c.name === name),
      };
    });
  const views = objects
    .filter((o) => o.type === "Postgres::View" || o.type === "Postgres::MaterializedView")
    .map((o): PostgresViewInfo => {
      const v = o as unknown as PostgresViewJson;
      const declared = v.columns ?? [];
      return {
        ...v,
        qualifiedName: relationKey(v),
        materialized: v.type === "Postgres::MaterializedView",
        outputs: declared.length > 0 ? [...declared] : (v.lineage ?? []).map((e) => e.output),
      };
    });
  return {
    dialect: "postgres",
    major,
    tables,
    views,
    indexes,
    objects,
    table: (ref) => tables.find((t) => t.export === ref) ?? tables.find((t) => t.qualifiedName === ref) ?? tables.find((t) => t.name === ref),
  };
}

const cache = new WeakMap<object, PostgresRead>();

/**
 * What a Postgres build declares, read from a post-synth context's `docs`
 * (a `lint.policies` check's `ctx`), or from the serialized output document
 * itself. Empty when the build has no Postgres output. The result is cached
 * per context; treat it as read-only.
 */
export function readPostgres(source: SqlReadSource | { dialect: string; objects: unknown[]; postgresMajor?: number }): PostgresRead {
  if ("objects" in source) {
    const objects = source.dialect === "postgres" ? (source.objects as SqlObjectJson[]) : [];
    return build(objects, typeof source.postgresMajor === "number" ? source.postgresMajor : PINNED_MAJOR);
  }
  const key = source.docs;
  const hit = key ? cache.get(key) : undefined;
  if (hit) return hit;
  const read = build(dialectObjects(source, "postgres"), recordedPostgresMajor(source, PINNED_MAJOR));
  if (key) cache.set(key, read);
  return read;
}
