import { baseType, checkOf, tablesOf } from "./postgres-helpers";

/**
 * SQLPG103: a serial column where an identity column is preferred.
 *
 * Doc: https://www.postgresql.org/docs/18/datatype-numeric.html#DATATYPE-SERIAL
 * (serial is a notational convenience that creates a sequence the column does
 * not own as a constraint); https://www.postgresql.org/docs/18/sql-createtable.html
 * documents GENERATED ... AS IDENTITY, the standard form. Prior art: squawk
 * prefer-identity.
 */
export const sqlpg103 = checkOf({ id: "SQLPG103", description: "A serial column where an identity column is preferred" }, (ctx, report) => {
  for (const t of tablesOf(ctx)) {
    for (const c of t.columns) {
      if (!/^(small|big)?serial[248]?$/.test(baseType(c.type))) continue;
      report({
        severity: "warning",
        message: `${t.export}.${c.name} is ${c.type}; declare it as an identity column (GENERATED ALWAYS AS IDENTITY)`,
        entity: t.export,
      });
    }
  }
});
