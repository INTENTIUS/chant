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
  SQLPG114: auditRule("SQLPG114", "merge-worthy", "guidance", "A storage parameter the object's kind or the pinned major does not accept", "Fix the parameter name, or use one from the pinned major's catalog.", { category: "correctness" }),
  SQLPG115: auditRule("SQLPG115", "report-only", "guidance", "A feature the oldest supported major lacks", "Avoid the feature, or drop support for the older major.", { category: "correctness" }),
  SQLPG116: auditRule("SQLPG116", "merge-worthy", "guidance", "An extension the pinned major no longer ships", "Remove the extension, or pin an older major.", { category: "best-practice" }),
  SQLPG117: auditRule("SQLPG117", "report-only", "guidance", "A view without security_invoker runs with its owner's privileges", "Set security_invoker = true in the view's WITH options.", { category: "security" }),
  SQLPG118: auditRule("SQLPG118", "report-only", "guidance", "A table uses INHERITS where declarative partitioning replaced it", "Use PARTITION BY and PARTITION OF.", { category: "best-practice" }),
};
