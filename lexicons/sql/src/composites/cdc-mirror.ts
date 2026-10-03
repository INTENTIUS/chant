/**
 * `CdcMirror`: a ReplacingMergeTree mirror of a source database table fed by change data capture, with a view of its live rows.
 *
 * A CDC pipeline (ClickPipes, Debezium through Kafka, PeerDB) writes every
 * change to a source row as a new row here, with an increasing version and a
 * deleted flag. ReplacingMergeTree with both arguments keeps the latest
 * version per primary key and, on merge, drops rows whose latest version is a
 * delete. The `current` view reads the table with `FINAL` and without deleted
 * rows, which is what a query of the source table would have returned.
 */

import { Composite } from "@intentius/chant/composite";
import { table, view, type ClickHouseTable, type ClickHouseView } from "../clickhouse/entities";

export interface CdcMirrorProps {
  /** The mirror table's name. The view of live rows is `<name>_current`. */
  name: string;
  /** The source table's columns, as SQL, without the version and deleted columns. */
  columns: string;
  /** The source table's primary key, the mirror's sort key: `id` or `(tenant_id, id)`. */
  primaryKey: string;
  /** The version column the pipeline writes (default `_version`, UInt64). */
  version?: string;
  /** The deleted flag the pipeline writes (default `_is_deleted`, UInt8, 1 for a delete). */
  deleted?: string;
  /** A `PARTITION BY` expression. Left out by default. */
  partitionBy?: string;
}

export type CdcMirrorMembers = {
  table: ClickHouseTable;
  current: ClickHouseView;
};

/** A ReplacingMergeTree mirror of a CDC-fed source table, with a view of the rows not deleted. */
export const CdcMirror = Composite<CdcMirrorProps, CdcMirrorMembers>((props) => {
  const version = props.version ?? "_version";
  const deleted = props.deleted ?? "_is_deleted";
  const mirror = table`
    CREATE TABLE ${props.name} (
      ${props.columns},
      ${version} UInt64,
      ${deleted} UInt8
    )
    ENGINE = ReplacingMergeTree(${version}, ${deleted})
    ${props.partitionBy ? `PARTITION BY ${props.partitionBy}` : ""}
    ORDER BY ${props.primaryKey}`;
  const current = view`
    CREATE VIEW ${`${props.name}_current`} AS
    SELECT * EXCEPT (${version}, ${deleted})
    FROM ${mirror} FINAL
    WHERE ${deleted} = 0`;
  return { table: mirror, current };
}, "CdcMirror");
