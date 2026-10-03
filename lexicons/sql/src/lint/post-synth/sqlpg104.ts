import { baseType, checkOf, tablesOf } from "./postgres-helpers";

/**
 * SQLPG104: a timestamp column without time zone.
 *
 * Doc: https://www.postgresql.org/docs/18/datatype-datetime.html (timestamp
 * without time zone ignores any zone in the input, so the value means
 * different instants to clients in different zones); the Postgres wiki's
 * "Don't Do This" says the same. Prior art: squawk prefer-timestamptz.
 */
export const sqlpg104 = checkOf({ id: "SQLPG104", description: "A timestamp column without time zone" }, (ctx, report) => {
  for (const t of tablesOf(ctx)) {
    for (const c of t.columns) {
      const type = baseType(c.type);
      if (type !== "timestamp" && type !== "timestamp without time zone") continue;
      report({
        severity: "warning",
        message: `${t.export}.${c.name} is ${c.type}; use timestamptz, which stores an instant`,
        entity: t.export,
      });
    }
  }
});
