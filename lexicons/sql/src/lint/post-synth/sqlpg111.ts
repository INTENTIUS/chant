import { checkOf, indexesOf, isMaterializedView } from "./postgres-helpers";
import { postgresObjects } from "./sql-helpers";

/**
 * SQLPG111: a materialized view with no unique index.
 *
 * Doc: https://www.postgresql.org/docs/18/sql-refreshmaterializedview.html
 * ("CONCURRENTLY ... is only allowed if there is at least one UNIQUE index on
 * the materialized view which uses only column names and includes all rows").
 * Without one, every refresh takes an ACCESS EXCLUSIVE lock and blocks readers.
 */
export const sqlpg111 = checkOf({ id: "SQLPG111", description: "A materialized view has no unique index, so it cannot refresh concurrently" }, (ctx, report) => {
  const indexes = indexesOf(ctx);
  for (const v of postgresObjects(ctx).filter(isMaterializedView)) {
    const ok = indexes.some((i) => i.tableName === v.sqlName && i.unique && !i.where && i.elements.every((e) => e.column));
    if (ok) continue;
    report({
      severity: "warning",
      message: `${v.export} (${v.sqlName}) has no unique index over plain columns; REFRESH MATERIALIZED VIEW CONCURRENTLY is refused and a plain refresh blocks readers`,
      entity: v.export,
    });
  }
});
