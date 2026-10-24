/**
 * `StreamIngest`: the usual ClickHouse ingestion chain, a stream table, a materialized view reading it and a MergeTree target.
 *
 * The stream table (Kafka, S3Queue, AzureQueue, RabbitMQ, NATS or FileLog)
 * stores no rows: it is the consumer. The materialized view pulls each batch
 * through it with `TO` and writes the target, which is an ordinary MergeTree
 * table that can be queried, altered and backfilled on its own. Every column
 * the view's select list writes has to be one the target declares (SQLCH110).
 *
 * The stream engine usually carries credentials. Name a named collection as
 * its first argument (`Kafka(kafka_creds)`, `S3Queue(lake_creds)`) and keep
 * the broker, bucket and keys in the collection on the server: chant never
 * declares or reads one (#4395), and SQLCH128 fails a build that writes a
 * password in the engine's arguments.
 *
 * A change to the stream table is planned as SQLCH225, not as a rebuild: the
 * view is detached, the table replaced and the view attached again. A
 * different `kafka_group_name` or S3Queue `keeper_path` loses the table's
 * position, and the plan says so (#4396).
 */

import { Composite } from "@intentius/chant/composite";
import { table, view, type ClickHouseTable, type ClickHouseView } from "../clickhouse/entities";
import type { ClickHouseMemberName } from "../core/typed";
import type { Instance, TypedComposite } from "./typed";

export interface StreamIngestProps {
  /** The target table's name. The stream table is `<name>_stream` and the view `<name>_mv`. */
  name: string;
  /** The target's columns, as SQL: `ts DateTime, user_id UInt64, kind LowCardinality(String)`. */
  columns: string;
  /**
   * The stream table's engine, with a named collection as its first argument
   * rather than inline credentials: `Kafka(kafka_creds)`, `S3Queue(lake_creds)`.
   */
  engine: string;
  /**
   * The engine's settings, the body of a `SETTINGS` clause:
   * `kafka_topic_list = 'events', kafka_group_name = 'ingest', kafka_format = 'JSONEachRow'`.
   * Settings the named collection already holds are left out.
   */
  settings?: string;
  /** The stream table's columns when they differ from the target's: the message as it arrives. Default: `columns`. */
  streamColumns?: string;
  /** The view's select list over the stream table, each item aliased to a target column. Default: `*`. */
  select?: string;
  /** The target's sort key (a column list or an expression). */
  orderBy: string;
  /** The target's engine (default `MergeTree`). */
  targetEngine?: string;
  /** The target's partition key. Left out by default. */
  partitionBy?: string;
}

/** `Target`, `Stream` and `View` are the members' names, when the call's props give them (chant#3787). */
export type StreamIngestMembers<Target extends string = string, Stream extends string = string, View extends string = string> = {
  target: ClickHouseTable<Target>;
  stream: ClickHouseTable<Stream>;
  view: ClickHouseView<View>;
};

type StreamIngestCall = <const N extends string>(
  props: StreamIngestProps & { name: N },
) => Instance<StreamIngestMembers<ClickHouseMemberName<N>, ClickHouseMemberName<N, "_stream">, ClickHouseMemberName<N, "_mv">>>;

/** A stream table, the materialized view that reads it, and the MergeTree target the view writes. */
export const StreamIngest = Composite<StreamIngestProps, StreamIngestMembers, TypedComposite<StreamIngestProps, StreamIngestMembers, StreamIngestCall>>((props) => {
  const target = table`
    CREATE TABLE ${props.name} (${props.columns})
    ENGINE = ${props.targetEngine ?? "MergeTree"}
    ${props.partitionBy ? `PARTITION BY ${props.partitionBy}` : ""}
    ORDER BY ${props.orderBy}`;
  const stream = table`
    CREATE TABLE ${`${props.name}_stream`} (${props.streamColumns ?? props.columns})
    ENGINE = ${props.engine}
    ${props.settings ? `SETTINGS ${props.settings}` : ""}`;
  const ingest = view`
    CREATE MATERIALIZED VIEW ${`${props.name}_mv`} TO ${target} AS
    SELECT ${props.select ?? "*"}
    FROM ${stream}`;
  return { target, stream, view: ingest };
}, "StreamIngest");
