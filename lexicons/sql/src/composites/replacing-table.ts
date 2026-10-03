/**
 * `ReplacingTable`: a ReplacingMergeTree table with a version column.
 *
 * ReplacingMergeTree keeps one row per sort key. When a merge meets rows with
 * the same key it keeps the one with the highest version, so writing a row
 * again with a higher version is how an update is expressed. Until a merge
 * runs, a query sees every version; read with `FINAL`, or aggregate with
 * `argMax`, when the latest row is what you want.
 *
 * Every field is built from a parameter or fixed by the template, inside the
 * subset `chant build` interprets, so a drift on the table is reported against
 * the parameter that produced the field when the composite is interpreted.
 */

import { Composite } from "@intentius/chant/composite";
import { table, type ClickHouseTable } from "../clickhouse/entities";

export interface ReplacingTableProps {
  /** The table's name, `name` or `database.name`. */
  name: string;
  /** Every column except the version column, as SQL: `id UInt64, email String`. */
  columns: string;
  /** The sort key, which is also the key rows are deduplicated by: `id` or `(tenant_id, id)`. */
  orderBy: string;
  /** The version column (default `version`). The row with the highest version survives a merge. */
  version?: string;
  /** The version column's type (default `UInt64`): a UInt, Date, DateTime or DateTime64. */
  versionType?: string;
  /** A `PARTITION BY` expression. Left out by default: a deduplicating table is usually small enough not to need one. */
  partitionBy?: string;
}

export type ReplacingTableMembers = {
  table: ClickHouseTable;
};

/** A ReplacingMergeTree table that keeps the highest version of each row, with its version column. */
export const ReplacingTable = Composite<ReplacingTableProps, ReplacingTableMembers>((props) => {
  const version = props.version ?? "version";
  const replacing = table`
    CREATE TABLE ${props.name} (
      ${props.columns},
      ${version} ${props.versionType ?? "UInt64"}
    )
    ENGINE = ReplacingMergeTree(${version})
    ${props.partitionBy ? `PARTITION BY ${props.partitionBy}` : ""}
    ORDER BY ${props.orderBy}`;
  return { table: replacing };
}, "ReplacingTable");
