import { checkOf, indexesOf, leadingColumns, ownsColumns, tablesOf } from "./postgres-helpers";

/**
 * SQLPG102: a foreign key whose referencing columns no index leads with.
 *
 * Doc: https://www.postgresql.org/docs/18/ddl-constraints.html#DDL-CONSTRAINTS-FK
 * ("it is often a good idea to index the referencing columns too ... a delete
 * of a referenced row requires a scan of the referencing table"). The primary
 * key, a UNIQUE constraint or an index covers the key when its leading columns
 * are the foreign key's columns, in any order.
 */
export const sqlpg102 = checkOf({ id: "SQLPG102", description: "A foreign key's referencing columns have no index" }, (ctx, report) => {
  const indexes = indexesOf(ctx);
  const sameSet = (a: string[], b: string[]) => a.length === b.length && a.every((c) => b.includes(c));
  for (const t of tablesOf(ctx)) {
    if (!ownsColumns(t)) continue;
    const covers: string[][] = [];
    if (t.primaryKey) covers.push(t.primaryKey.columns);
    for (const u of t.uniques) covers.push(u.columns);
    for (const i of indexes) if (i.tableName === t.sqlName && (i.method ?? "btree") === "btree") covers.push(leadingColumns(i));
    for (const fk of t.foreignKeys) {
      if (covers.some((c) => c.length >= fk.columns.length && sameSet(c.slice(0, fk.columns.length), fk.columns))) continue;
      report({
        severity: "warning",
        message: `${t.export} (${t.sqlName}) has a foreign key on (${fk.columns.join(", ")}) to ${fk.refTable} with no index leading with those columns; deletes and updates of the referenced row scan the table`,
        entity: t.export,
      });
    }
  }
});
