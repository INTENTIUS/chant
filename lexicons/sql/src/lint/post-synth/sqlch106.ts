import { checkOf, isTable, mentionedNames } from "./clickhouse-helpers";
import { clickhouseObjects } from "./sql-helpers";

/**
 * SQLCH106: a data skipping index expression mentions a column the table does
 * not declare.
 *
 * Doc: https://clickhouse.com/docs/optimize/skipping-indexes (an index is
 * defined over an expression of the table's columns). Projections are not
 * checked: their SELECT is a full query, and reading its column names without a
 * SQL parser would guess.
 */
export const sqlch106 = checkOf({ id: "SQLCH106", description: "A skip index expression names a column the table does not declare" }, (ctx, report) => {
  for (const t of clickhouseObjects(ctx).filter(isTable)) {
    if (t.columns.length === 0) continue;
    const declared = new Set(t.columns.map((c) => c.name));
    for (const index of t.indexes ?? []) {
      const missing = [...new Set(mentionedNames(index.expr))].filter((n) => !declared.has(n));
      if (missing.length === 0) continue;
      report({
        severity: "error",
        message: `${t.export} (${t.name}): index ${index.name} (${index.expr}) names ${missing.join(", ")}, which the table does not declare`,
        entity: t.export,
      });
    }
  }
});
