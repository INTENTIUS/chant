import { baseType, checkOf, tablesOf } from "./postgres-helpers";

/**
 * SQLPG105: a json column where jsonb fits.
 *
 * Doc: https://www.postgresql.org/docs/18/datatype-json.html ("the jsonb data
 * type is faster to process ... and supports indexing"; json has no equality
 * operator, so SELECT DISTINCT, GROUP BY and UNION fail on it). Prior art:
 * strong_migrations "Adding a json column".
 */
export const sqlpg105 = checkOf({ id: "SQLPG105", description: "A json column where jsonb fits" }, (ctx, report) => {
  for (const t of tablesOf(ctx)) {
    for (const c of t.columns) {
      if (baseType(c.type) !== "json") continue;
      report({
        severity: "warning",
        message: `${t.export}.${c.name} is json; use jsonb unless the exact text, key order or duplicate keys must be kept`,
        entity: t.export,
      });
    }
  }
});
