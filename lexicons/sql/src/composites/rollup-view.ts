/**
 * `RollupView`: a materialized view that rolls a source table up into its own target table.
 *
 * The target is a SummingMergeTree (or another engine named by `engine`)
 * sorted by the rollup's grouping key. The materialized view writes into it
 * with `TO`, so the target is an ordinary table that can be queried, altered
 * and backfilled on its own, and dropping the view leaves the data. Every
 * column the select list writes has to be one the target declares
 * (SQLCH110), so alias each select item to a target column.
 *
 * The view reads `source` by reference, so it depends on the source and on
 * its target, and the build orders all three.
 */

import { Composite } from "@intentius/chant/composite";
import { table, view, type ClickHouseRelation, type ClickHouseTable, type ClickHouseView } from "../clickhouse/entities";

export interface RollupViewProps {
  /** The target table's name. The view is `<name>_mv`. */
  name: string;
  /** The table or view the rollup reads, as the entity: `events`. */
  source: ClickHouseRelation;
  /** The target's columns, as SQL: `day Date, kind LowCardinality(String), n UInt64`. */
  columns: string;
  /** The select list, each item aliased to a target column: `toDate(ts) AS day, kind, count() AS n`. */
  select: string;
  /** The grouping key: `day, kind`. */
  groupBy: string;
  /** The target's sort key (default `groupBy` in parentheses). Summing collapses rows that share it. */
  orderBy?: string;
  /** The target's engine (default `SummingMergeTree`). Use `AggregatingMergeTree` for `-State` columns. */
  engine?: string;
  /** The target's partition key. Left out by default. */
  partitionBy?: string;
}

export type RollupViewMembers = {
  table: ClickHouseTable;
  view: ClickHouseView;
};

/** A materialized view that rolls a source table up into a target table it declares beside it. */
export const RollupView = Composite<RollupViewProps, RollupViewMembers>((props) => {
  const target = table`
    CREATE TABLE ${props.name} (${props.columns})
    ENGINE = ${props.engine ?? "SummingMergeTree"}
    ${props.partitionBy ? `PARTITION BY ${props.partitionBy}` : ""}
    ORDER BY ${props.orderBy ?? `(${props.groupBy})`}`;
  const rollup = view`
    CREATE MATERIALIZED VIEW ${`${props.name}_mv`} TO ${target} AS
    SELECT ${props.select}
    FROM ${props.source}
    GROUP BY ${props.groupBy}`;
  return { table: target, view: rollup };
}, "RollupView");
