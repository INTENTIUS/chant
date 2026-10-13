import { baseType, checkOf, tablesOf } from "./postgres-helpers";

/**
 * SQLPG107: a money column.
 *
 * Doc: https://www.postgresql.org/docs/18/datatype-money.html ("the output of
 * this type depends on lc_monetary ... restoring a dump into a database with
 * a different lc_monetary setting may not work"; it holds a fixed number of
 * decimals and no currency). Use numeric(p, s).
 */
export const sqlpg107 = checkOf({ id: "SQLPG107", description: "A money column" }, (ctx, report) => {
  for (const t of tablesOf(ctx)) {
    for (const c of t.columns) {
      if (baseType(c.type) !== "money") continue;
      report({
        severity: "warning",
        message: `${t.export}.${c.name} is money, whose rounding and output depend on lc_monetary; use numeric(p, s) and a currency column`,
        entity: t.export,
      });
    }
  }
});
