/**
 * ClickHouse composites: tables and views that are usually declared together,
 * built from the `table` and `view` tags so each field keeps its provenance.
 */

export { ReplacingTable, type ReplacingTableProps, type ReplacingTableMembers } from "./replacing-table";
export { EventsTable, type EventsTableProps, type EventsTableMembers } from "./events-table";
export { RollupView, type RollupViewProps, type RollupViewMembers } from "./rollup-view";
export { CdcMirror, type CdcMirrorProps, type CdcMirrorMembers } from "./cdc-mirror";
export { ShardedTable, type ShardedTableProps, type ShardedTableMembers } from "./sharded-table";
