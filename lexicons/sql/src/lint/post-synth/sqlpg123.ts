import { checkOf, indexesOf, tablesOf } from "./postgres-helpers";
import { columnsOf, includeColumns, interpolatedTable, projectOf } from "./postgres-names";

/**
 * SQLPG123: a bare column name in a key, index or grant column list that the
 * table does not declare.
 *
 * Doc: https://www.postgresql.org/docs/18/sql-createtable.html,
 * https://www.postgresql.org/docs/18/sql-createindex.html,
 * https://www.postgresql.org/docs/18/sql-grant.html. The server refuses
 * `column "idd" named in key does not exist` (or `column "emial" does not
 * exist`) at CREATE or GRANT. Checked: `PRIMARY KEY`, `UNIQUE` and their
 * `INCLUDE`, a foreign key's own columns, an index's bare columns and
 * `INCLUDE` on a `${}` table, and a `GRANT`/`REVOKE` column list on a `${}`
 * table. An expression (an index expression, a CHECK, a generated column) is
 * left to the server, as is a table whose columns come from somewhere the
 * build cannot see (`LIKE`, `OF type`, a plain-text parent).
 */
export const sqlpg123 = checkOf({ id: "SQLPG123", description: "A key, index or grant column list names a column the table does not declare" }, (ctx, report) => {
  const p = projectOf(ctx);
  const verify = (entity: string, sqlName: string, where: string, tableName: string, names: readonly string[], cols: ReadonlyMap<string, unknown>) => {
    for (const n of new Set(names)) {
      if (cols.has(n)) continue;
      report({ severity: "error", message: `${entity} (${sqlName}) ${where} names the column ${n}, which ${tableName} does not declare`, entity });
    }
  };
  for (const t of tablesOf(ctx)) {
    const cols = columnsOf(p, t);
    if (!cols) continue;
    if (t.primaryKey) {
      verify(t.export, t.sqlName, "PRIMARY KEY", t.sqlName, t.primaryKey.columns, cols);
      verify(t.export, t.sqlName, "PRIMARY KEY ... INCLUDE", t.sqlName, includeColumns(t.primaryKey.include), cols);
    }
    for (const u of t.uniques) {
      verify(t.export, t.sqlName, "UNIQUE", t.sqlName, u.columns, cols);
      verify(t.export, t.sqlName, "UNIQUE ... INCLUDE", t.sqlName, includeColumns(u.include), cols);
    }
    for (const fk of t.foreignKeys) verify(t.export, t.sqlName, `FOREIGN KEY to ${fk.refTable}`, t.sqlName, fk.columns, cols);
  }
  for (const i of indexesOf(ctx)) {
    const t = interpolatedTable(p, i.table, i.tableName);
    const cols = t && columnsOf(p, t);
    if (!cols) continue;
    verify(i.export, i.sqlName, `index on ${i.tableName}`, i.tableName, i.elements.flatMap((e) => (e.column ? [e.column] : [])), cols);
    verify(i.export, i.sqlName, `index on ${i.tableName} INCLUDE`, i.tableName, includeColumns(i.include), cols);
  }
  for (const g of p.objects) {
    if (g.type !== "Postgres::Grant" || g.on !== "table") continue;
    const objects = (g.objects as unknown[]) ?? [];
    const names = (g.objectNames as string[]) ?? [];
    const privileges = (g.privileges as Array<{ privilege: string; columns?: string[] }>) ?? [];
    objects.forEach((ref, n) => {
      const t = interpolatedTable(p, ref, names[n]);
      const cols = t && columnsOf(p, t);
      if (!cols) return;
      for (const priv of privileges) {
        if (!priv.columns?.length) continue;
        const action = g.action === "revoke" ? "REVOKE" : "GRANT";
        verify(g.export, String(g.name), `${action} ${priv.privilege.toUpperCase()} on ${t!.sqlName}`, t!.sqlName, priv.columns, cols);
      }
    });
  }
});
