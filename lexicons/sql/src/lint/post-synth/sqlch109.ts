import { checkOf, isMaterializedView } from "./clickhouse-helpers";
import { clickhouseObjects } from "./sql-helpers";

/**
 * SQLCH109: a materialized view selects `*`.
 *
 * Doc: https://clickhouse.com/docs/materialized-view/incremental-materialized-view
 * (the view's columns come from the SELECT, and a materialized view is a
 * trigger on inserts). A star ties the target's columns to whatever the source
 * has today, so adding a source column changes what the view writes.
 */
export const sqlch109 = checkOf({ id: "SQLCH109", description: "A materialized view selects *" }, (ctx, report) => {
  for (const v of clickhouseObjects(ctx).filter(isMaterializedView)) {
    if (!(v.lineage ?? []).some((e) => e.expr === "*" || /\.\*$/.test(e.expr))) continue;
    report({
      severity: "warning",
      message: `${v.export} (${v.name}) selects *; list the columns so a new source column does not change what the view writes`,
      entity: v.export,
    });
  }
});
