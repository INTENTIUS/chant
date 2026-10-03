/**
 * `SoftDeleteTable`: a table whose rows carry created and updated timestamps and are deleted by marking them.
 *
 * The composite appends `created_at` and `updated_at` (both `timestamptz NOT
 * NULL DEFAULT now()`) and a nullable `deleted_at` to the columns it is
 * given. A row is live while `deleted_at` is null. The `<name>_live` view
 * reads the live rows (it sets `security_invoker`, so row-level security on
 * the table applies to whoever reads the view), and a partial index on the
 * live rows keeps lookups by the key the app uses off the dead ones.
 *
 * Postgres has no column default that follows an update: the app, or a
 * trigger it owns, sets `updated_at`.
 */

import { Composite } from "@intentius/chant/composite";
import { index, literal, table, view, type PostgresIndex, type PostgresSchema, type PostgresTable, type PostgresView } from "../postgres/entities";

export interface SoftDeleteTableProps {
  /** The table's name, unqualified. The view is `<name>_live`. */
  name: string;
  /** The schema the table, its index and its view live in: the entity, or its name (default `public`). */
  schema?: PostgresSchema | string;
  /** Every column except the three the composite adds, as SQL, with the primary key: `id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, title text NOT NULL`. */
  columns: string;
  /** The column the live-rows index covers: the one the app looks rows up by, as SQL (default `id`). */
  liveKey?: string;
  /** The table's comment, which also covers its columns for SQLPG112 (default: says rows are soft-deleted). */
  comment?: string;
  /** The creation timestamp column (default `created_at`). */
  createdAt?: string;
  /** The update timestamp column (default `updated_at`). */
  updatedAt?: string;
  /** The deletion timestamp column (default `deleted_at`). Null means the row is live. */
  deletedAt?: string;
}

export type SoftDeleteTableMembers = {
  table: PostgresTable;
  live: PostgresView;
  liveIndex: PostgresIndex;
};

/** A table with created and updated timestamps and a soft-delete column, a view of its live rows and an index over them. */
export const SoftDeleteTable = Composite<SoftDeleteTableProps, SoftDeleteTableMembers>((props) => {
  const schema = props.schema ?? "public";
  const deleted = props.deletedAt ?? "deleted_at";
  const rows = table`
    CREATE TABLE ${schema}.${props.name} (
      ${props.columns},
      ${props.createdAt ?? "created_at"} timestamptz NOT NULL DEFAULT now(),
      ${props.updatedAt ?? "updated_at"} timestamptz NOT NULL DEFAULT now(),
      ${deleted} timestamptz
    );
    COMMENT ON TABLE ${schema}.${props.name} IS ${literal(props.comment ?? "Soft-deleted: a row is live while its deletion timestamp is null")}`;
  const live = view`
    CREATE VIEW ${schema}.${`${props.name}_live`} WITH (security_invoker = true) AS
    SELECT * FROM ${rows} WHERE ${deleted} IS NULL`;
  const liveIndex = index`
    CREATE INDEX ${`${props.name}_live_idx`} ON ${rows} (${props.liveKey ?? "id"}) WHERE ${deleted} IS NULL`;
  return { table: rows, live, liveIndex };
}, "SoftDeleteTable");
