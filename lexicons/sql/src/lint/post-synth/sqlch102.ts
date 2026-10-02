import { checkOf, isTable, keyElements } from "./clickhouse-helpers";
import { clickhouseObjects } from "./sql-helpers";

/**
 * SQLCH102: a PRIMARY KEY that is not a prefix of ORDER BY.
 *
 * Doc: https://clickhouse.com/docs/engines/table-engines/mergetree-family/mergetree
 * ("The primary key must be a prefix of the sorting key"); the server refuses
 * the table at CREATE.
 */
export const sqlch102 = checkOf({ id: "SQLCH102", description: "A PRIMARY KEY is not a prefix of ORDER BY" }, (ctx, report) => {
  for (const t of clickhouseObjects(ctx).filter(isTable)) {
    if (!t.primaryKey || !t.orderBy) continue;
    const pk = keyElements(t.primaryKey).map((e) => e.replace(/\s+/g, ""));
    const ob = keyElements(t.orderBy).map((e) => e.replace(/\s+/g, ""));
    if (pk.every((e, i) => ob[i] === e)) continue;
    report({
      severity: "error",
      message: `${t.export} (${t.name}) has PRIMARY KEY ${t.primaryKey}, which is not a prefix of ORDER BY ${t.orderBy}`,
      entity: t.export,
    });
  }
});
