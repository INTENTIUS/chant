import { checkOf, isMaterializedView, isTable, resolveObject, type TableObject } from "./clickhouse-helpers";
import { clickhouseObjects } from "./sql-helpers";

/**
 * SQLCH110: a materialized view writes an output column its TO target table
 * does not declare.
 *
 * Doc: https://clickhouse.com/docs/sql-reference/statements/create/view
 * (a materialized view with TO inserts the SELECT's result into the target;
 * columns are matched by name, so a column the target lacks is not stored).
 * Judged only against a target the same build declares, and only when the
 * SELECT lists its columns.
 */
export const sqlch110 = checkOf({ id: "SQLCH110", description: "A materialized view writes a column its TO target does not declare" }, (ctx, report) => {
  for (const v of clickhouseObjects(ctx).filter(isMaterializedView)) {
    if (!v.to || (v.lineage ?? []).some((e) => e.expr === "*" || /\.\*$/.test(e.expr))) continue;
    const target = resolveObject(ctx, v.to);
    if (!target || !isTable(target) || (target as TableObject).columns.length === 0) continue;
    const declared = new Set((target as TableObject).columns.map((c) => c.name));
    const outputs = v.columns.length > 0 ? v.columns.map((c) => c.name) : v.lineage.map((e) => e.output);
    const dropped = outputs.filter((n) => !declared.has(n));
    if (dropped.length === 0) continue;
    report({
      severity: "warning",
      message: `${v.export} (${v.name}) selects ${dropped.join(", ")}, which ${target.name} does not declare; ClickHouse matches by name, so the value is not stored`,
      entity: v.export,
    });
  }
});
