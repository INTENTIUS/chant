import { checkOf } from "./postgres-helpers";
import { callsIn, expressionsOf, projectOf, resolveCall } from "./postgres-names";

/**
 * SQLPG126: a call to a function the target major does not have, in a column
 * `DEFAULT`, a generated column, a `CHECK` (a table's or a domain's), or an
 * index expression.
 *
 * Doc: https://www.postgresql.org/docs/18/functions.html. The server refuses
 * `function noww() does not exist` at CREATE. A name counts when it is in
 * the target major's `pg_proc`, a function or procedure the project declares,
 * a type name used as a cast (`int4(x)`), or qualified with a schema the
 * project does not declare. Only a name directly followed by `(`, outside
 * string literals, is a call; the grammar's own constructs that read like
 * calls (`COALESCE`, `NULLIF`, `GREATEST`, `LEAST`, `CAST`, `EXTRACT`, `ROW`,
 * `ARRAY`, `EXISTS`, `IN`, `ANY`, `ALL`, `SOME`, and the key word forms of
 * `OVERLAY`, `POSITION`, `SUBSTRING` and `TRIM`) are reserved or column-name
 * key words, not `pg_proc` names, and are skipped by their key word category.
 * An error, or a warning when the project declares an extension.
 */
export const sqlpg126 = checkOf({ id: "SQLPG126", description: "An expression calls a function the target major does not have" }, (ctx, report) => {
  const p = projectOf(ctx);
  for (const o of p.objects) {
    const seen = new Set<string>();
    for (const { where, expr } of expressionsOf(o)) {
      for (const c of callsIn(expr)) {
        const label = `${c.schema ? `${c.schema}.` : ""}${c.name}`;
        if (seen.has(`${where}\0${label}`)) continue;
        seen.add(`${where}\0${label}`);
        const r = resolveCall(p, c);
        if (r.ok) continue;
        const why = r.since !== undefined ? `, which needs Postgres ${r.since}; Postgres ${p.major} does not have it` : r.until !== undefined ? `, which Postgres removed after ${r.until}` : `, which Postgres ${p.major} does not have`;
        report({ severity: r.miss.severity, message: `${o.export} (${o.sqlName as string}) ${where} calls ${label}()${why}${r.miss.note}`, entity: o.export });
      }
    }
  }
});
