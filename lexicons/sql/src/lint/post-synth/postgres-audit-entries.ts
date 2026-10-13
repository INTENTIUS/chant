/**
 * Audit metadata for the Postgres post-synth checks (SQLPG1xx). Spread into
 * `sqlAuditCatalog` by ../audit-catalog.ts. Deprecation checks are filed under
 * best-practice or correctness: the audit categories have no deprecation of
 * their own.
 */

import { auditRule, type RuleMeta } from "@intentius/chant/audit/catalog";

export const postgresPostSynthAuditEntries: Record<string, RuleMeta> = {
  SQLPG101: auditRule("SQLPG101", "merge-worthy", "guidance", "A table declares no primary key", "Add a primary key, or a UNIQUE constraint over NOT NULL columns.", { category: "best-practice" }),
  SQLPG102: auditRule("SQLPG102", "report-only", "guidance", "A foreign key's referencing columns have no index", "Create an index whose leading columns are the foreign key's columns.", { category: "best-practice" }),
  SQLPG103: auditRule("SQLPG103", "report-only", "guidance", "A serial column where an identity column is preferred", "Declare the column GENERATED ALWAYS AS IDENTITY.", { category: "best-practice" }),
  SQLPG104: auditRule("SQLPG104", "report-only", "guidance", "A timestamp column without time zone", "Use timestamptz.", { category: "correctness" }),
  SQLPG105: auditRule("SQLPG105", "report-only", "guidance", "A json column where jsonb fits", "Use jsonb unless the exact text must be kept.", { category: "best-practice" }),
  SQLPG106: auditRule("SQLPG106", "report-only", "guidance", "A char(n) column", "Use text, or varchar(n) for a length rule.", { category: "best-practice" }),
  SQLPG107: auditRule("SQLPG107", "report-only", "guidance", "A money column", "Use numeric(p, s) and a currency column.", { category: "correctness" }),
  SQLPG108: auditRule("SQLPG108", "report-only", "guidance", "A varchar(n) column with a habitual length limit", "Use text, with a CHECK where the length is a rule.", { category: "best-practice" }),
  SQLPG109: auditRule("SQLPG109", "report-only", "guidance", "An index duplicates a constraint or another index", "Drop the duplicate index.", { category: "best-practice" }),
  SQLPG110: auditRule("SQLPG110", "report-only", "guidance", "A btree index is a prefix of another index", "Drop the prefix index; the wider one serves the same queries.", { category: "best-practice" }),
  SQLPG111: auditRule("SQLPG111", "report-only", "guidance", "A materialized view has no unique index, so it cannot refresh concurrently", "Add a unique index over plain columns.", { category: "correctness" }),
  SQLPG112: auditRule("SQLPG112", "report-only", "guidance", "A secret- or PII-named column with no comment on it or its table", "Add a COMMENT saying what it holds and how it is protected.", { category: "security" }),
  SQLPG113: auditRule("SQLPG113", "report-only", "guidance", "An object is in the public schema though the project declares schemas", "Qualify the object with a declared schema.", { category: "best-practice" }),
  SQLPG114: auditRule("SQLPG114", "merge-worthy", "guidance", "A storage parameter the object's kind or the target major does not accept", "Fix the parameter name, or use one from the target major's catalog.", { category: "correctness" }),
  SQLPG115: auditRule("SQLPG115", "report-only", "guidance", "A feature newer than the target major", "Avoid the feature, or raise sql.postgresMajor.", { category: "correctness" }),
  SQLPG116: auditRule("SQLPG116", "merge-worthy", "guidance", "An extension the target major no longer ships", "Remove the extension, or set sql.postgresMajor to an older major.", { category: "best-practice" }),
  SQLPG117: auditRule("SQLPG117", "report-only", "guidance", "A view without security_invoker runs with its owner's privileges", "Set security_invoker = true in the view's WITH options.", { category: "security" }),
  SQLPG118: auditRule("SQLPG118", "report-only", "guidance", "A table uses INHERITS where declarative partitioning replaced it", "Use PARTITION BY and PARTITION OF.", { category: "best-practice" }),
  SQLPG119: auditRule("SQLPG119", "merge-worthy", "guidance", "A column, domain or sequence type the target major does not have", "Fix the type name, declare the type, or declare the extension that provides it.", { category: "correctness" }),
  SQLPG120: auditRule("SQLPG120", "merge-worthy", "guidance", "A type modifier that does not fit the type", "Drop the modifier, or bring it into the type's range.", { category: "correctness" }),
  SQLPG121: auditRule("SQLPG121", "merge-worthy", "guidance", "An identity column whose type is not smallint, integer or bigint", "Declare the identity column smallint, integer or bigint.", { category: "correctness" }),
  SQLPG122: auditRule("SQLPG122", "merge-worthy", "guidance", "A table declares a column twice, or an enum lists a label twice", "Remove or rename the repeated column or label.", { category: "correctness" }),
  SQLPG123: auditRule("SQLPG123", "merge-worthy", "guidance", "A key, index or grant column list names a column the table does not declare", "Fix the column name, or write it as ${table.columns.name}.", { category: "correctness" }),
  SQLPG124: auditRule("SQLPG124", "merge-worthy", "guidance", "A foreign key names a column the referenced table lacks, or one of another type category", "Reference a declared column, and give the referencing column a type of the same category.", { category: "correctness" }),
  SQLPG125: auditRule("SQLPG125", "merge-worthy", "guidance", "An index access method or operator class the target major does not have, or not for that method", "Use a method and operator class the target major has, or declare the extension that provides them.", { category: "correctness" }),
  SQLPG126: auditRule("SQLPG126", "merge-worthy", "guidance", "An expression calls a function the target major does not have", "Fix the function name, declare the function, or declare the extension that provides it.", { category: "correctness" }),
};
