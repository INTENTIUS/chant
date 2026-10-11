/**
 * Audit metadata for the ClickHouse post-synth checks (SQLCH1xx). Spread into
 * `sqlAuditCatalog` by ../audit-catalog.ts. Deprecation checks are filed under
 * best-practice: the audit categories have no deprecation of their own.
 */

import { auditRule, type RuleMeta } from "@intentius/chant/audit/catalog";

export const sqlPostSynthAuditEntries: Record<string, RuleMeta> = {
  SQLCH102: auditRule("SQLCH102", "merge-worthy", "guidance", "A PRIMARY KEY that is not a prefix of ORDER BY", "Make the primary key a leading prefix of the sort key, or drop it to use the sort key.", { category: "correctness" }),
  SQLCH103: auditRule("SQLCH103", "merge-worthy", "guidance", "An engine's version, sign or is_deleted column has an unsupported type", "Use UInt*, Date, DateTime or DateTime64 for a version, Int8 for a sign, UInt8 for is_deleted.", { category: "correctness" }),
  SQLCH104: auditRule("SQLCH104", "merge-worthy", "guidance", "A MergeTree engine argument names a column the table does not declare", "Declare the column, or fix the name in the engine arguments.", { category: "correctness" }),
  SQLCH105: auditRule("SQLCH105", "merge-worthy", "guidance", "A table key clause names a column the table does not declare", "Declare the column, or fix the name in ORDER BY, PRIMARY KEY, PARTITION BY or SAMPLE BY.", { category: "correctness" }),
  SQLCH106: auditRule("SQLCH106", "merge-worthy", "guidance", "A skip index expression names a column the table does not declare", "Declare the column, or fix the index expression.", { category: "correctness" }),
  SQLCH107: auditRule("SQLCH107", "merge-worthy", "guidance", "A TTL expression is built on a column that is not a Date or DateTime", "Base the TTL on a Date or DateTime column, or convert it in the expression.", { category: "correctness" }),
  SQLCH108: auditRule("SQLCH108", "merge-worthy", "guidance", "CREATE OR REPLACE TABLE in a database that is not Atomic", "Create the database with ENGINE = Atomic or Replicated, or drop OR REPLACE.", { category: "correctness" }),
  SQLCH109: auditRule("SQLCH109", "report-only", "guidance", "A materialized view selects *", "List the columns the view writes.", { category: "best-practice" }),
  SQLCH110: auditRule("SQLCH110", "report-only", "guidance", "A materialized view writes a column its TO target does not declare", "Add the column to the target table, or drop it from the SELECT.", { category: "correctness" }),
  SQLCH111: auditRule("SQLCH111", "report-only", "guidance", "A String column limited to a few values is not LowCardinality", "Declare the column LowCardinality(String).", { category: "best-practice" }),
  SQLCH112: auditRule("SQLCH112", "report-only", "guidance", "A PARTITION BY expression is finer than a day", "Partition by month (toYYYYMM) or day, and keep the finer time in ORDER BY.", { category: "best-practice" }),
  SQLCH113: auditRule("SQLCH113", "merge-worthy", "guidance", "A MergeTree table declares no sort key", "Add ORDER BY, or ORDER BY tuple() for no sorting.", { category: "correctness" }),
  SQLCH114: auditRule("SQLCH114", "merge-worthy", "guidance", "A column codec is not one the pinned server has", "Use a codec from the pinned server's system.codecs.", { category: "correctness" }),
  SQLCH115: auditRule("SQLCH115", "report-only", "guidance", "A secret- or PII-named column carries no comment, TTL or encryption", "Add a COMMENT saying what it holds, a TTL that bounds retention, or an AES_*_GCM_SIV codec.", { category: "security" }),
  SQLCH116: auditRule("SQLCH116", "report-only", "guidance", "A view is SQL SECURITY DEFINER with no DEFINER", "Write DEFINER = <user> before SQL SECURITY DEFINER.", { category: "security" }),
  SQLCH117: auditRule("SQLCH117", "report-only", "guidance", "A MergeTree setting is obsolete at the pinned server", "Remove the setting; the server ignores it.", { category: "best-practice" }),
  SQLCH118: auditRule("SQLCH118", "merge-worthy", "guidance", "A MergeTree setting is not one the pinned server has", "Fix the setting name, or pick a setting from the pinned server's system.merge_tree_settings.", { category: "correctness" }),
  SQLCH119: auditRule("SQLCH119", "report-only", "guidance", "An object uses a deprecated or experimental engine", "Use the engine that replaced it (Atomic for Ordinary), or accept the experimental engine knowingly.", { category: "best-practice" }),
  SQLCH120: auditRule("SQLCH120", "report-only", "guidance", "A MergeTree engine uses the deprecated positional arguments", "Write a bare MergeTree with ORDER BY, PARTITION BY and SETTINGS.", { category: "best-practice" }),
  SQLCH121: auditRule("SQLCH121", "merge-worthy", "guidance", "A column type names a family the pinned server does not have", "Use a type family from the pinned server's system.data_type_families, in the case it lists unless it is case-insensitive.", { category: "correctness" }),
  SQLCH122: auditRule("SQLCH122", "merge-worthy", "guidance", "A column type's parameters do not fit its family", "Give the family the parameters it takes, each within its range.", { category: "correctness" }),
  SQLCH123: auditRule("SQLCH123", "merge-worthy", "guidance", "A Nullable wraps a type ClickHouse does not allow inside Nullable", "Move Nullable inside (Array(Nullable(T)), LowCardinality(Nullable(T))) or drop it.", { category: "correctness" }),
  SQLCH124: auditRule("SQLCH124", "merge-worthy", "guidance", "A table declares a column twice", "Remove or rename one of the two columns.", { category: "correctness" }),
  SQLCH125: auditRule("SQLCH125", "merge-worthy", "guidance", "A codec parameter is outside what the codec takes", "Give the codec a parameter within its range or set, or drop the parameter for the default.", { category: "correctness" }),
  SQLCH126: auditRule("SQLCH126", "merge-worthy", "guidance", "A GRANT column list names a column the table does not declare", "Fix the column name, or declare the column on the table.", { category: "correctness" }),
  SQLCH127: auditRule("SQLCH127", "merge-worthy", "guidance", "An expression calls a function the pinned server does not have", "Fix the function name, use one from the pinned server's system.functions, or declare it with func.", { category: "correctness" }),
};
