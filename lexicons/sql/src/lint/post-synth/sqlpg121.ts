import { checkOf, tablesOf } from "./postgres-helpers";
import { parseType, projectOf, resolveType } from "./postgres-names";

const IDENTITY_TYPES = new Set(["smallint", "integer", "bigint"]);

/**
 * SQLPG121: an identity column whose type is not `smallint`, `integer` or
 * `bigint`.
 *
 * Doc: https://www.postgresql.org/docs/18/sql-createtable.html ("GENERATED {
 * ALWAYS | BY DEFAULT } AS IDENTITY ... The column ... must be of type
 * smallint, integer or bigint"). The server refuses `identity column type must
 * be smallint, integer, or bigint` at CREATE. A declared type (a domain) is
 * left to the server.
 */
export const sqlpg121 = checkOf({ id: "SQLPG121", description: "An identity column whose type is not smallint, integer or bigint" }, (ctx, report) => {
  const p = projectOf(ctx);
  for (const t of tablesOf(ctx)) {
    for (const c of t.columns) {
      if (c.generated?.kind !== "identity") continue;
      const parsed = parseType(c.type);
      if (!parsed) continue;
      const r = resolveType(p, parsed, { serial: true });
      if (r.kind !== "builtin" || (IDENTITY_TYPES.has(r.canonical) && !parsed.array)) continue;
      report({
        severity: "error",
        message: `${t.export} (${t.sqlName}) column ${c.name} is an identity column of type ${c.type}; an identity column must be smallint, integer or bigint`,
        entity: t.export,
      });
    }
  }
});
