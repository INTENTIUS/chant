/**
 * Storage parameters (`WITH (fillfactor = 70)`): the overlay half.
 *
 * No catalog table lists them; they are compiled into `reloptions.c`.
 * Generation probes the server instead: it tries every `pg_settings` name plus
 * {@link STORAGE_PARAMETER_SEED} as `WITH (name = 1)` on each relation kind
 * and keeps every name the server does not reject as unrecognized. The probe
 * yields names only, so the types and ranges are here, and generation fails
 * when a name the probe found has no entry (a pin move that adds a parameter
 * has to type it in the same commit) or an entry names nothing the probe found.
 */

import { INT_MAX } from "./kinds";

/** The reloptions that are not `pg_settings` names, so the probe would never try them. */
export const STORAGE_PARAMETER_SEED: readonly string[] = [
  "fillfactor", "toast_tuple_target", "parallel_workers", "user_catalog_table", "autovacuum_enabled",
  "vacuum_index_cleanup", "vacuum_truncate", "autovacuum_vacuum_threshold", "autovacuum_vacuum_scale_factor",
  "autovacuum_vacuum_max_threshold", "autovacuum_vacuum_insert_threshold", "autovacuum_vacuum_insert_scale_factor",
  "autovacuum_analyze_threshold", "autovacuum_analyze_scale_factor", "autovacuum_vacuum_cost_delay",
  "autovacuum_vacuum_cost_limit", "autovacuum_freeze_min_age", "autovacuum_freeze_max_age",
  "autovacuum_freeze_table_age", "autovacuum_multixact_freeze_min_age", "autovacuum_multixact_freeze_max_age",
  "autovacuum_multixact_freeze_table_age", "log_autovacuum_min_duration", "deduplicate_items", "buffering",
  "fastupdate", "gin_pending_list_limit", "pages_per_range", "autosummarize", "security_barrier",
  "security_invoker", "check_option", "vacuum_cleanup_index_scale_factor", "vacuum_max_eager_freeze_failure_rate",
];

export type StorageParameterType =
  | { kind: "integer"; range: readonly [number, number] }
  | { kind: "real"; range: readonly [number, number] }
  | { kind: "boolean" }
  | { kind: "enum"; values: readonly string[] };

const int = (min: number, max: number): StorageParameterType => ({ kind: "integer", range: [min, max] });
const real = (min: number, max: number): StorageParameterType => ({ kind: "real", range: [min, max] });
const bool: StorageParameterType = { kind: "boolean" };

/** Keyed by parameter name; the same name has the same type on every relation kind that accepts it. */
export const STORAGE_PARAMETER_TYPES: Record<string, StorageParameterType> = {
  fillfactor: int(10, 100),
  toast_tuple_target: int(128, 1073741823),
  parallel_workers: int(0, 1024),
  user_catalog_table: bool,
  autovacuum_enabled: bool,
  vacuum_index_cleanup: { kind: "enum", values: ["auto", "on", "off", "true", "false"] },
  vacuum_truncate: bool,
  autovacuum_vacuum_threshold: int(0, INT_MAX),
  autovacuum_vacuum_scale_factor: real(0, 100),
  autovacuum_vacuum_max_threshold: int(-1, INT_MAX),
  autovacuum_vacuum_insert_threshold: int(-1, INT_MAX),
  autovacuum_vacuum_insert_scale_factor: real(0, 100),
  autovacuum_analyze_threshold: int(0, INT_MAX),
  autovacuum_analyze_scale_factor: real(0, 100),
  autovacuum_vacuum_cost_delay: real(-1, 100),
  autovacuum_vacuum_cost_limit: int(-1, 10000),
  autovacuum_freeze_min_age: int(0, 1000000000),
  autovacuum_freeze_max_age: int(100000, 2000000000),
  autovacuum_freeze_table_age: int(0, 2000000000),
  autovacuum_multixact_freeze_min_age: int(0, 1000000000),
  autovacuum_multixact_freeze_max_age: int(10000, 2000000000),
  autovacuum_multixact_freeze_table_age: int(0, 2000000000),
  log_autovacuum_min_duration: int(-1, INT_MAX),
  vacuum_max_eager_freeze_failure_rate: real(0, 1),
  security_barrier: bool,
  security_invoker: bool,
  check_option: { kind: "enum", values: ["local", "cascaded"] },
  deduplicate_items: bool,
  // Accepted and ignored since 14, which removed the feature; kept so a dump from 13 still restores.
  vacuum_cleanup_index_scale_factor: real(0, 10000000000),
  buffering: { kind: "enum", values: ["on", "off", "auto"] },
  fastupdate: bool,
  gin_pending_list_limit: int(64, INT_MAX),
  pages_per_range: int(1, 131072),
  autosummarize: bool,
};
