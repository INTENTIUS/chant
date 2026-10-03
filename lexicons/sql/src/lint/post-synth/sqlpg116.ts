import { checkOf, rangeOf, targetMajor } from "./postgres-helpers";
import { postgresObjects } from "./sql-helpers";

/**
 * SQLPG116: an extension the target major no longer ships.
 *
 * Doc: https://www.postgresql.org/docs/18/contrib.html and the release notes
 * of the major that dropped it (adminpack and old_snapshot are gone after 16,
 * https://www.postgresql.org/docs/17/release-17.html). The target is `postgresMajor` in the output. The extension names
 * and their since/until majors come from the generated catalog, read from
 * pg_available_extensions of each major's server image.
 */
export const sqlpg116 = checkOf({ id: "SQLPG116", description: "An extension the target major no longer ships" }, (ctx, report) => {
  const major = targetMajor(ctx);
  for (const o of postgresObjects(ctx)) {
    if (o.type !== "Postgres::Extension") continue;
    const until = rangeOf("extensions", o.name)?.until;
    if (until === undefined || until >= major) continue;
    report({
      severity: "error",
      message: `${o.export} installs the ${o.name} extension, which Postgres ${major} does not ship (last in ${until})`,
      entity: o.export,
    });
  }
});
