import { checkOf, ownsColumns, tablesOf } from "./postgres-helpers";

/**
 * SQLPG101: a table with no primary key.
 *
 * Doc: https://www.postgresql.org/docs/18/ddl-constraints.html#DDL-CONSTRAINTS-PRIMARY-KEYS
 * ("a primary key indicates that a column or group of columns can be used as a
 * unique identifier for rows"). Without one, logical replication needs a
 * REPLICA IDENTITY and rows cannot be addressed by identity. A partition, a
 * typed table and a LIKE copy are skipped, and a UNIQUE constraint over NOT
 * NULL columns counts as an identity.
 */
export const sqlpg101 = checkOf({ id: "SQLPG101", description: "A table declares no primary key" }, (ctx, report) => {
  for (const t of tablesOf(ctx)) {
    if (!ownsColumns(t) || t.primaryKey || t.like.length > 0) continue;
    const notNull = new Set(t.columns.filter((c) => c.notNull).map((c) => c.name));
    if (t.uniques.some((u) => u.columns.length > 0 && u.columns.every((c) => notNull.has(c)))) continue;
    report({
      severity: "warning",
      message: `${t.export} (${t.sqlName}) has no primary key; add one, or a UNIQUE constraint over NOT NULL columns`,
      entity: t.export,
    });
  }
});
