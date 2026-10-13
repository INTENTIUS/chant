import { checkOf, indexesOf } from "./postgres-helpers";
import { parseIndexElement, projectOf, resolveMethod, resolveOpClass } from "./postgres-names";

/**
 * SQLPG125: an index access method or operator class the target major does
 * not have, or an operator class that is not for the index's method.
 *
 * Doc: https://www.postgresql.org/docs/18/sql-createindex.html and
 * https://www.postgresql.org/docs/18/indexes-opclass.html. The server refuses
 * `access method "btreee" does not exist` and `operator class "numeric_opz"
 * does not exist for access method "btree"` at CREATE. Methods and operator
 * classes come from the target major's catalog (`pg_am`, `pg_opclass`). The
 * ones an extension adds (`gin_trgm_ops` from pg_trgm, `hnsw` from vector)
 * pass when the project declares that extension and are an error naming it
 * when it does not; one neither the catalog nor the extension overlay knows is
 * a warning when the project declares any extension. An operator class
 * qualified with a schema the project does not declare is left alone.
 */
export const sqlpg125 = checkOf({ id: "SQLPG125", description: "An index access method or operator class the target major does not have, or not for that method" }, (ctx, report) => {
  const p = projectOf(ctx);
  for (const i of indexesOf(ctx)) {
    const method = i.method ?? "btree";
    const m = resolveMethod(p, method);
    if (!m.ok) {
      report({ severity: m.miss.severity, message: `${i.export} (${i.sqlName}) uses the index access method ${method}, which Postgres ${p.major} does not have${m.miss.note}`, entity: i.export });
      continue;
    }
    for (const e of i.elements) {
      const opclass = parseIndexElement(e.expr)?.opclass;
      if (!opclass) continue;
      const r = resolveOpClass(p, method, opclass);
      if (r.ok) continue;
      const label = `${opclass.schema ? `${opclass.schema}.` : ""}${opclass.name}`;
      const message = r.otherMethods
        ? `${i.export} (${i.sqlName}) uses the operator class ${label}, which is for ${r.otherMethods.join(", ")}, not ${method}`
        : `${i.export} (${i.sqlName}) uses the operator class ${label}, which Postgres ${p.major} does not have for ${method}${r.miss.note}`;
      report({ severity: r.miss.severity, message, entity: i.export });
    }
  }
});
