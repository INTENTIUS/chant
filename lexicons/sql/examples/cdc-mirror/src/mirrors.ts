import { CdcMirror } from "@intentius/chant-lexicon-sql/clickhouse";

// Written by a CDC pipeline: every change is a new row with a higher version.
// The columns are `chant migrate --from sql/postgres --to sql/clickhouse
// --use-composites` over ../postgres-cdc-source, then reviewed: country and
// status became LowCardinality (SQLRV004), and orders takes PeerDB's column
// names and a monthly partition (SQLRV002, SQLRV009). The workspace link in
// lexicons/sql/src/migrate/from-postgres/example.test.ts keeps the column
// names in step with the Postgres side.
export const customers = CdcMirror({
  name: "customers",
  columns: "id Int64, email String COMMENT 'PII, hashed downstream', country LowCardinality(String), created_at DateTime64(6, 'UTC')",
  primaryKey: "id",
});

// PeerDB names its columns differently.
export const orders = CdcMirror({
  name: "orders",
  columns: "id Int64, customer_id Int64, total Decimal(12, 2), status LowCardinality(String), placed_at DateTime64(6, 'UTC')",
  primaryKey: "id",
  version: "_peerdb_version",
  deleted: "_peerdb_is_deleted",
  partitionBy: "toYYYYMM(placed_at)",
});
