import { checkOf, isTable } from "./clickhouse-helpers";
import { clickhouseObjects } from "./sql-helpers";

/**
 * SQLCH120: a MergeTree engine written with the legacy positional arguments.
 *
 * Doc: https://clickhouse.com/docs/engines/table-engines/mergetree-family/mergetree
 * ("Deprecated Method for Creating a Table": `MergeTree(date-column
 * [, sampling_expression], (primary, key), index_granularity)`). Current
 * syntax is a bare `MergeTree` with ORDER BY, PARTITION BY and SETTINGS.
 */
export const sqlch120 = checkOf({ id: "SQLCH120", description: "A MergeTree engine uses the deprecated positional arguments" }, (ctx, report) => {
  for (const t of clickhouseObjects(ctx).filter(isTable)) {
    if (t.engine?.name !== "MergeTree" || (t.engine.args ?? []).length === 0) continue;
    report({
      severity: "warning",
      message: `${t.export} (${t.name}) is MergeTree(${t.engine.args!.join(", ")}), the deprecated positional form; use ORDER BY, PARTITION BY and SETTINGS`,
      entity: t.export,
    });
  }
});
