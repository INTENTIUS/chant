/**
 * `EventsTable`: an append-only MergeTree events table, partitioned by month and expired by TTL.
 *
 * The table is partitioned by its timestamp (by month unless `partitionBy`
 * says otherwise) and drops rows older than `ttlDays`. It sets
 * `ttl_only_drop_parts`, so expiry drops whole parts once every row in them
 * has expired instead of rewriting parts to remove single rows, which is cheap
 * when the partition and the TTL follow the same column.
 */

import { Composite } from "@intentius/chant/composite";
import { table, type ClickHouseTable } from "../clickhouse/entities";
import type { ClickHouseMemberName } from "../core/typed";
import type { Instance, TypedComposite } from "./typed";

export interface EventsTableProps {
  /** The table's name, `name` or `database.name`. */
  name: string;
  /** Every column except the timestamp, as SQL: `user_id UUID, kind LowCardinality(String)`. */
  columns: string;
  /** The sort key. Put the columns queries filter on first: `(kind, user_id, ts)`. */
  orderBy: string;
  /** The timestamp column (default `ts`). TTL and the default partition key read it. */
  timestamp?: string;
  /** The timestamp's type (default `DateTime`): a Date, DateTime or DateTime64. */
  timestampType?: string;
  /** Days a row is kept (default 90). */
  ttlDays?: number;
  /** The partition key (default `toYYYYMM(<timestamp>)`). Keep it no finer than a day. */
  partitionBy?: string;
}

/** `Table` is the table's name, when the call's props give it (chant#3787). */
export type EventsTableMembers<Table extends string = string> = {
  table: ClickHouseTable<Table>;
};

type EventsTableCall = <const N extends string>(props: EventsTableProps & { name: N }) => Instance<EventsTableMembers<ClickHouseMemberName<N>>>;

/** An append-only MergeTree events table, partitioned by its timestamp and expired by TTL. */
export const EventsTable = Composite<EventsTableProps, EventsTableMembers, TypedComposite<EventsTableProps, EventsTableMembers, EventsTableCall>>((props) => {
  const ts = props.timestamp ?? "ts";
  const events = table`
    CREATE TABLE ${props.name} (
      ${props.columns},
      ${ts} ${props.timestampType ?? "DateTime"}
    )
    ENGINE = MergeTree
    PARTITION BY ${props.partitionBy ?? `toYYYYMM(${ts})`}
    ORDER BY ${props.orderBy}
    TTL ${ts} + INTERVAL ${props.ttlDays ?? 90} DAY
    SETTINGS ttl_only_drop_parts = 1`;
  return { table: events };
}, "EventsTable");
