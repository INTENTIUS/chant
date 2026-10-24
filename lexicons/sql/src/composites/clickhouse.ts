/** The ClickHouse composites, exported at `@intentius/chant-lexicon-sql/clickhouse`. */

export { ReplacingTable, type ReplacingTableProps, type ReplacingTableMembers } from "./replacing-table";
export { EventsTable, type EventsTableProps, type EventsTableMembers } from "./events-table";
export { RollupView, type RollupViewProps, type RollupViewMembers } from "./rollup-view";
export { CdcMirror, type CdcMirrorProps, type CdcMirrorMembers } from "./cdc-mirror";
export { ShardedTable, type ShardedTableProps, type ShardedTableMembers } from "./sharded-table";
export { OtelTables, OTEL_EXPORTER_DEFAULT_TABLES, otelTtlClause, type OtelTablesProps, type OtelTablesMembers, type OtelTableNames } from "./otel-tables";
export { StreamIngest, type StreamIngestProps, type StreamIngestMembers } from "./stream-ingest";
