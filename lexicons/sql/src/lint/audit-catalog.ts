/**
 * The sql lexicon's chant audit catalog, contributed via `auditCatalog()`.
 *
 * Post-synth checks read the build's JSON output, so they are `yamlBased`. The
 * source-level rules read TypeScript and are constructed with
 * `yamlBased: false`; they are listed for a reader who meets them in a report.
 */

import { applyLineage, auditRule, type RuleMeta } from "@intentius/chant/audit/catalog";
import { sqlPostSynthAuditEntries } from "./post-synth/audit-entries";
import { postgresPostSynthAuditEntries } from "./post-synth/postgres-audit-entries";
import { sqlAuditLineage } from "./audit-lineage";

function sourceRule(id: string, category: RuleMeta["category"], title: string, remediation: string): RuleMeta {
  return { id, tier: "merge-worthy", fixKind: "guidance", category, title, remediation, yamlBased: false };
}

export const sqlAuditCatalog: Record<string, RuleMeta> = {
  SQLCH001: sourceRule(
    "SQLCH001",
    "correctness",
    "ClickHouse DDL in a database, table or view template does not parse",
    "Fix the statement at the token the message names.",
  ),
  SQLCH002: sourceRule(
    "SQLCH002",
    "correctness",
    "A Nullable column in a ClickHouse sort key or primary key",
    "Make the column non-Nullable, drop it from the key, or set allow_nullable_key = 1 on the table.",
  ),
  SQLCH003: sourceRule(
    "SQLCH003",
    "correctness",
    "A column interpolated without .columns reads the entity's own field instead",
    "Write ${table.columns.name}.",
  ),
  SQLPG001: sourceRule(
    "SQLPG001",
    "correctness",
    "Postgres DDL in a tagged template does not parse, or holds another statement than its tag",
    "Fix the statement at the token the message names, or use the tag for the statement it holds; name every index.",
  ),
  SQLPG002: sourceRule(
    "SQLPG002",
    "correctness",
    "A column interpolated without .columns reads the entity's own field instead",
    "Write ${table.columns.name}.",
  ),
  SQLPG003: sourceRule(
    "SQLPG003",
    "correctness",
    "A sequence or relation named in a regclass string makes no reference",
    "Interpolate the declared object: nextval(${sequence}) or ${relation}::regclass.",
  ),
  SQLPG004: sourceRule(
    "SQLPG004",
    "correctness",
    "A declared extension the configured Postgres provider does not allow",
    "Use an extension the provider lists, or set sql.provider to the service the project deploys to.",
  ),
  SQLCH101: auditRule(
    "SQLCH101",
    "merge-worthy",
    "guidance",
    "A ClickHouse object names an engine the pinned server does not have",
    "Use an engine from the pinned server's system.table_engines (or system.database_engines for a database).",
    { category: "correctness" },
  ),
  ...sqlPostSynthAuditEntries,
  ...postgresPostSynthAuditEntries,
};

applyLineage(sqlAuditCatalog, sqlAuditLineage);
