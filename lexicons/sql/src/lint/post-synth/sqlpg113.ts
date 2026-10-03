import { checkOf } from "./postgres-helpers";
import { postgresObjects } from "./sql-helpers";

const PLACED = new Set(["Postgres::Table", "Postgres::View", "Postgres::MaterializedView", "Postgres::Sequence", "Postgres::Enum", "Postgres::Domain"]);

/**
 * SQLPG113: an object in the public schema while the project declares schemas.
 *
 * Doc: https://www.postgresql.org/docs/18/ddl-schemas.html#DDL-SCHEMAS-PUBLIC
 * and https://www.postgresql.org/docs/18/ddl-schemas.html#DDL-SCHEMAS-PATTERNS
 * (the usage patterns recommend that applications not share `public`). An
 * unqualified name is created in the first schema of search_path, usually
 * public. Silent for a project that declares no schema.
 */
export const sqlpg113 = checkOf({ id: "SQLPG113", description: "An object is in the public schema though the project declares schemas" }, (ctx, report) => {
  const objects = postgresObjects(ctx);
  if (!objects.some((o) => o.type === "Postgres::Schema")) return;
  for (const o of objects) {
    if (!PLACED.has(o.type)) continue;
    const schema = (o.schema as string | undefined) ?? "public";
    if (schema !== "public") continue;
    report({
      severity: "warning",
      message: `${o.export} (${o.sqlName}) is in the public schema; qualify it with one of the declared schemas`,
      entity: o.export,
    });
  }
});
