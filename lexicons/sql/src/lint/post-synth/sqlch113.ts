import { checkOf, isMergeTree, isTable } from "./clickhouse-helpers";
import { clickhouseObjects } from "./sql-helpers";

/**
 * SQLCH113: a MergeTree table with neither ORDER BY nor PRIMARY KEY.
 *
 * Doc: https://clickhouse.com/docs/engines/table-engines/mergetree-family/mergetree
 * ("ORDER BY: required unless PRIMARY KEY is specified"; write
 * `ORDER BY tuple()` to have none). The server refuses the CREATE.
 */
export const sqlch113 = checkOf({ id: "SQLCH113", description: "A MergeTree table declares no sort key" }, (ctx, report) => {
  for (const t of clickhouseObjects(ctx).filter(isTable)) {
    if (!isMergeTree(t.engine) || t.orderBy || t.primaryKey) continue;
    report({
      severity: "error",
      message: `${t.export} (${t.name}) uses ${t.engine!.name} with no ORDER BY or PRIMARY KEY; add one, or ORDER BY tuple() for none`,
      entity: t.export,
    });
  }
});
