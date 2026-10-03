/**
 * `AuditLogTable`: an append-only audit log partitioned by month.
 *
 * The parent is `PARTITION BY RANGE (<timestamp>)`, and its primary key
 * includes the timestamp, which Postgres requires of every unique key on a
 * partitioned table. The composite declares a default partition so no insert
 * is refused before a month's partition exists; a partition per month is
 * created ahead of time by whatever the project uses for partition upkeep (a
 * `FOR VALUES FROM ('2026-10-01') TO ('2026-11-01')` partition of the parent
 * is one more `table` call). An index on `(<actor>, <timestamp>)` serves the
 * question an audit log is asked most: what did this actor do, and when.
 */

import { Composite } from "@intentius/chant/composite";
import { index, table, type PostgresIndex, type PostgresSchema, type PostgresTable } from "../postgres/entities";

export interface AuditLogTableProps {
  /** The table's name, unqualified. The default partition is `<name>_default`. */
  name: string;
  /** The schema the table and its partitions live in: the entity, or its name (default `public`). */
  schema?: PostgresSchema | string;
  /** The event time column, the partition key (default `occurred_at`). */
  timestamp?: string;
  /** The column naming who acted (default `actor`). */
  actor?: string;
}

export type AuditLogTableMembers = {
  table: PostgresTable;
  defaultPartition: PostgresTable;
  actorIndex: PostgresIndex;
};

/** An append-only audit log partitioned by month on its timestamp, with a default partition and an index by actor. */
export const AuditLogTable = Composite<AuditLogTableProps, AuditLogTableMembers>((props) => {
  const schema = props.schema ?? "public";
  const ts = props.timestamp ?? "occurred_at";
  const actor = props.actor ?? "actor";
  const log = table`
    CREATE TABLE ${schema}.${props.name} (
      id bigint GENERATED ALWAYS AS IDENTITY,
      ${ts} timestamptz NOT NULL DEFAULT now(),
      ${actor} text NOT NULL,
      action text NOT NULL,
      subject text,
      details jsonb NOT NULL DEFAULT '{}',
      PRIMARY KEY (id, ${ts})
    ) PARTITION BY RANGE (${ts})`;
  const fallback = table`
    CREATE TABLE ${schema}.${`${props.name}_default`} PARTITION OF ${log} DEFAULT`;
  const byActor = index`
    CREATE INDEX ${`${props.name}_actor_idx`} ON ${log} (${actor}, ${ts} DESC)`;
  return { table: log, defaultPartition: fallback, actorIndex: byActor };
}, "AuditLogTable");
