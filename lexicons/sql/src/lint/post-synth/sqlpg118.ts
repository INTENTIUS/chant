import { checkOf, tablesOf } from "./postgres-helpers";

/**
 * SQLPG118: a table that uses INHERITS.
 *
 * Doc: https://www.postgresql.org/docs/18/ddl-partitioning.html#DDL-PARTITIONING-DECLARATIVE-BEST-PRACTICES
 * and https://www.postgresql.org/docs/18/ddl-inherit.html#DDL-INHERIT-CAVEATS
 * (indexes, unique constraints and foreign keys are not inherited, so a
 * constraint on the parent does not cover the children). Declarative
 * partitioning (PARTITION BY ... / PARTITION OF) replaced inheritance for
 * splitting a table; INHERITS is kept for its other uses.
 */
export const sqlpg118 = checkOf({ id: "SQLPG118", description: "A table uses INHERITS where declarative partitioning replaced it" }, (ctx, report) => {
  for (const t of tablesOf(ctx)) {
    if (t.inherits.length === 0) continue;
    report({
      severity: "warning",
      message: `${t.export} (${t.sqlName}) uses INHERITS; its parent's unique and foreign keys do not cover it, so use PARTITION OF for a split table`,
      entity: t.export,
    });
  }
});
