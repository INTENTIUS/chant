/**
 * Engine arguments: the overlay half (chant #3195).
 *
 * The generator reads each engine's argument names, positions and optionality
 * from the server's `syntax` line (`engine-syntax.ts`). This table adds what
 * that line cannot say: whether `ver` is a column, `cluster` a name, `min_time`
 * a number. Keys are the argument names exactly as the syntax line spells
 * them, and generation fails when one no longer appears there, so a pin move
 * that renames or drops an argument is caught rather than mistyped.
 *
 * Covered: the MergeTree family and its Replicated twins, and the engines a
 * schema commonly declares beside them (Distributed, Buffer, Join, Merge,
 * Dictionary, File, URL, Alias, KeeperMap, EmbeddedRocksDB, GenerateRandom).
 * Integration engines (S3, Kafka, the lake engines, the database bridges) keep
 * their arguments untyped: they are connection strings and credentials, which
 * lint has no business guessing at.
 */

import type { ArgumentOverlay } from "./kinds";

const REPLICATED: Record<string, ArgumentOverlay> = {
  zoo_path: {
    kind: "string",
    optional: true,
    note: "May be omitted together with replica_name when the server sets default_replica_path and default_replica_name.",
  },
  replica_name: { kind: "string", optional: true, note: "Omitted together with zoo_path." },
};

const SIGN: ArgumentOverlay = { kind: "column", note: "An Int8 column holding 1 for a state row and -1 for a cancel row." };
const VERSION: ArgumentOverlay = { kind: "column", note: "An unsigned integer, date or datetime column." };
const SUMMED: ArgumentOverlay = { kind: "columns", note: "Numeric columns to sum; every numeric column outside the sort key when omitted." };
const REPLACING: Record<string, ArgumentOverlay> = {
  ver: { kind: "column", note: "The version column: the row with the highest version wins; the last inserted when omitted." },
  is_deleted: { kind: "column", note: "A UInt8 column; 1 marks a deleted row. Requires ver." },
};

export const ENGINE_ARGUMENTS: Record<string, Record<string, ArgumentOverlay>> = {
  ReplacingMergeTree: REPLACING,
  SummingMergeTree: { columns: SUMMED },
  CoalescingMergeTree: { columns: SUMMED },
  CollapsingMergeTree: { sign: SIGN },
  VersionedCollapsingMergeTree: { sign: SIGN, version: VERSION },
  GraphiteMergeTree: { config_section: { kind: "string", note: "The graphite_rollup section of the server config." } },

  ReplicatedMergeTree: REPLICATED,
  ReplicatedAggregatingMergeTree: REPLICATED,
  ReplicatedReplacingMergeTree: { ...REPLICATED, ...REPLACING },
  ReplicatedSummingMergeTree: { ...REPLICATED, columns: SUMMED },
  ReplicatedCoalescingMergeTree: { ...REPLICATED, columns: SUMMED },
  ReplicatedCollapsingMergeTree: { ...REPLICATED, sign: SIGN },
  ReplicatedVersionedCollapsingMergeTree: { ...REPLICATED, sign: SIGN, version: VERSION },
  ReplicatedGraphiteMergeTree: { ...REPLICATED, config_section: { kind: "string" } },

  Distributed: {
    cluster: { kind: "identifier", note: "A cluster named in the server's remote_servers config." },
    database: { kind: "identifier" },
    table: { kind: "identifier" },
    sharding_key: { kind: "expression", note: "Required for INSERTs into a cluster of more than one shard." },
    policy_name: { kind: "string", note: "A storage policy for the files queued for sending." },
  },
  Buffer: {
    database: { kind: "identifier" },
    table: { kind: "identifier" },
    num_buckets: { kind: "number", range: [1, 1000], note: "Independent buffers; 16 is the documented default." },
    min_time: { kind: "number" },
    max_time: { kind: "number" },
    min_rows: { kind: "number" },
    max_rows: { kind: "number" },
    min_bytes: { kind: "number" },
    max_bytes: { kind: "number" },
    flush_time: { kind: "number" },
    flush_rows: { kind: "number" },
    flush_bytes: { kind: "number" },
  },
  Join: {
    join_strictness: { kind: "keyword", values: ["ANY", "ALL", "SEMI", "ANTI"] },
    join_type: { kind: "keyword", values: ["INNER", "LEFT", "RIGHT", "FULL", "CROSS"] },
    k1: { kind: "column" },
    k2: { kind: "column" },
  },
  Merge: {
    db_name: { kind: "expression", note: "A database name, or REGEXP('pattern')." },
    tables_regexp: { kind: "string" },
  },
  Dictionary: { dictionary_name: { kind: "identifier" } },
  File: {
    format: { kind: "identifier", note: "An input/output format name from system.formats." },
    "path|fd": { kind: "string" },
  },
  URL: {
    url: { kind: "string" },
    format: { kind: "identifier", note: "A format name from system.formats." },
    compression: { kind: "string" },
  },
  Alias: { target_db: { kind: "identifier" }, target_table: { kind: "identifier" } },
  KeeperMap: { root_path: { kind: "string" }, keys_limit: { kind: "number" } },
  EmbeddedRocksDB: {
    ttl: { kind: "number" },
    rocksdb_dir: { kind: "string" },
    read_only: { kind: "number", range: [0, 1] },
  },
  GenerateRandom: {
    random_seed: { kind: "number" },
    max_string_length: { kind: "number" },
    max_array_length: { kind: "number" },
  },
};
