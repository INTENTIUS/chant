import { CdcMirror } from "@intentius/chant-lexicon-sql/clickhouse";

// Written by a CDC pipeline: every change is a new row with a higher version.
export const customers = CdcMirror({
  name: "customers",
  columns: "id UInt64, email String COMMENT 'PII, hashed downstream', country LowCardinality(String), created_at DateTime",
  primaryKey: "id",
});

// PeerDB names its columns differently.
export const orders = CdcMirror({
  name: "orders",
  columns: "id UInt64, customer_id UInt64, total Decimal(12, 2), status LowCardinality(String), placed_at DateTime",
  primaryKey: "id",
  version: "_peerdb_version",
  deleted: "_peerdb_is_deleted",
  partitionBy: "toYYYYMM(placed_at)",
});
