import { checkOf, tablesOf } from "./postgres-helpers";
import { postgresObjects } from "./sql-helpers";

const repeated = (xs: readonly string[]): string[] => [...new Set(xs.filter((x, i) => xs.indexOf(x) !== i))];

/**
 * SQLPG122: a table that declares a column twice, or an enum that lists a
 * label twice.
 *
 * Doc: https://www.postgresql.org/docs/18/sql-createtable.html and
 * https://www.postgresql.org/docs/18/sql-createtype.html. The server refuses
 * `column "id" specified more than once` and `enum labels must be unique`.
 * Column names are compared as Postgres folds them; labels as written, since
 * they are case-sensitive strings.
 */
export const sqlpg122 = checkOf({ id: "SQLPG122", description: "A table declares a column twice, or an enum lists a label twice" }, (ctx, report) => {
  for (const t of tablesOf(ctx)) {
    for (const name of repeated(t.columns.map((c) => c.name))) {
      report({ severity: "error", message: `${t.export} (${t.sqlName}) declares the column ${name} more than once`, entity: t.export });
    }
  }
  for (const o of postgresObjects(ctx)) {
    if (o.type !== "Postgres::Enum") continue;
    for (const label of repeated((o.labels as string[] | undefined) ?? [])) {
      report({ severity: "error", message: `${o.export} (${o.sqlName as string}) lists the enum label '${label}' more than once`, entity: o.export });
    }
  }
});
