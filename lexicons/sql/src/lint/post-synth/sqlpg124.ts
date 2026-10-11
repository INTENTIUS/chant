import { checkOf, tablesOf } from "./postgres-helpers";
import { columnsOf, interpolatedTable, projectOf, typeIdentity } from "./postgres-names";

/**
 * SQLPG124: a foreign key to a `${}` table that names a column the table does
 * not declare, or pairs columns whose types do not compare.
 *
 * Doc: https://www.postgresql.org/docs/18/ddl-constraints.html#DDL-CONSTRAINTS-FK
 * and https://www.postgresql.org/docs/18/catalog-pg-type.html#CATALOG-TYPCATEGORY-TABLE.
 * The server refuses `column "idd" referenced in foreign key constraint does
 * not exist` and `Key columns "customer_id" and "id" are of incompatible
 * types: text and bigint`. Types compare by their catalog category: `integer`
 * to `bigint` (both numeric) passes, `text` to `bigint` fails. The
 * user-defined category (`uuid`, `bytea`, `jsonb`...) compares by type; a
 * domain by its base type; an enum by itself. A key to a table named in plain
 * text, or a type outside the project, is left to the server.
 */
export const sqlpg124 = checkOf({ id: "SQLPG124", description: "A foreign key names a column the referenced table lacks, or one of another type category" }, (ctx, report) => {
  const p = projectOf(ctx);
  for (const t of tablesOf(ctx)) {
    const own = columnsOf(p, t);
    for (const fk of t.foreignKeys) {
      const ref = interpolatedTable(p, (fk as { references?: unknown }).references, fk.refTable);
      const refCols = ref && columnsOf(p, ref);
      if (!ref || !refCols) continue;
      const targets = fk.refColumns.length > 0 ? fk.refColumns : (ref.primaryKey?.columns ?? []);
      const missing = targets.filter((c) => !refCols.has(c));
      for (const c of missing) {
        report({ severity: "error", message: `${t.export} (${t.sqlName}) has a foreign key on (${fk.columns.join(", ")}) to ${ref.sqlName} (${c}), which ${ref.sqlName} does not declare`, entity: t.export });
      }
      if (missing.length > 0 || !own || targets.length !== fk.columns.length) continue;
      fk.columns.forEach((c, n) => {
        const mine = own.get(c);
        const theirs = refCols.get(targets[n]!);
        if (!mine || !theirs) return;
        const a = typeIdentity(p, mine.type);
        const b = typeIdentity(p, theirs.type);
        if (a === undefined || b === undefined || a === b) return;
        report({
          severity: "error",
          message: `${t.export} (${t.sqlName}) has a foreign key from ${c} (${mine.type}) to ${ref.sqlName} (${targets[n]}) (${theirs.type}); the types do not compare, so Postgres refuses the key`,
          entity: t.export,
        });
      });
    }
  }
});
