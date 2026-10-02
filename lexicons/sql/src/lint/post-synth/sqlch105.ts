import { bareName, checkOf, isTable, keyElements } from "./clickhouse-helpers";
import { clickhouseObjects } from "./sql-helpers";

/**
 * SQLCH105: ORDER BY, PRIMARY KEY, PARTITION BY or SAMPLE BY lists a bare
 * column name the table does not declare.
 *
 * Doc: https://clickhouse.com/docs/engines/table-engines/mergetree-family/mergetree
 * (the keys are expressions over the table's columns). Only a bare name is
 * judged; an expression is left to the server.
 */
export const sqlch105 = checkOf({ id: "SQLCH105", description: "A table key clause names a column the table does not declare" }, (ctx, report) => {
  for (const t of clickhouseObjects(ctx).filter(isTable)) {
    if (t.columns.length === 0) continue;
    const declared = new Set(t.columns.map((c) => c.name));
    const clauses: Array<[string, string | undefined]> = [
      ["ORDER BY", t.orderBy],
      ["PRIMARY KEY", t.primaryKey],
      ["PARTITION BY", t.partitionBy],
      ["SAMPLE BY", t.sampleBy],
    ];
    for (const [clause, expr] of clauses) {
      if (!expr) continue;
      for (const element of keyElements(expr)) {
        const name = bareName(element);
        if (name === undefined || declared.has(name)) continue;
        report({
          severity: "error",
          message: `${t.export} (${t.name}): ${clause} names column ${name}, which the table does not declare`,
          entity: t.export,
        });
      }
    }
  }
});
