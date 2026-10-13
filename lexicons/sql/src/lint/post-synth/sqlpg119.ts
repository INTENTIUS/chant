import { checkOf, tablesOf } from "./postgres-helpers";
import { parseType, projectOf, resolveType, typeLabel } from "./postgres-names";

/**
 * SQLPG119: a column, array element, domain base or sequence `AS` type the
 * target major does not have.
 *
 * Doc: https://www.postgresql.org/docs/18/datatype.html. The server refuses
 * `type "numerik" does not exist` at CREATE. A built-in type counts in every
 * spelling Postgres accepts: the catalog's `pg_type` name and `format_type()`
 * name (`int4`, `integer`), and the grammar's own spellings (`int`, `decimal`,
 * `double precision`, `time with time zone`), an overlay beside the catalog.
 * So does a type the project declares (`type`, `domain`, a table's row type),
 * by `${}` or by name. A type qualified with a schema the project does not
 * declare is a plain-text reference and left to the server. An unknown name is
 * a warning when the project declares an extension, since extension types are
 * not in the core catalog; the overlay of common extension types answers for
 * the ones it knows.
 */
export const sqlpg119 = checkOf({ id: "SQLPG119", description: "A column, domain or sequence type the target major does not have" }, (ctx, report) => {
  const p = projectOf(ctx);
  const check = (entity: string, sqlName: string, what: string, text: string | undefined, serial: boolean) => {
    const t = parseType(text);
    if (!t) return;
    const r = resolveType(p, t, { serial });
    if (r.kind !== "missing") return;
    const kind = t.array ? "array element type" : "type";
    report({ severity: r.miss.severity, message: `${entity} (${sqlName}) ${what} ${kind} ${typeLabel(t)}, which Postgres ${p.major} does not have${r.miss.note}`, entity });
  };
  for (const t of tablesOf(ctx)) {
    for (const c of t.columns) check(t.export, t.sqlName, `column ${c.name} has`, c.type, true);
  }
  for (const o of p.objects) {
    if (o.type === "Postgres::Domain") check(o.export, o.sqlName as string, "is a domain over", o.dataType as string | undefined, false);
    if (o.type === "Postgres::Sequence") check(o.export, o.sqlName as string, "is a sequence of", o.dataType as string | undefined, false);
  }
});
