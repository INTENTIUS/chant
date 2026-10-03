import { checkOf, OLDEST_MAJOR, rangeOf, storageParams, storageTarget, tablesOf } from "./postgres-helpers";
import { indexesOf } from "./postgres-helpers";
import { postgresObjects } from "./sql-helpers";

/**
 * SQLPG115: a feature newer than the oldest supported major.
 *
 * Doc: https://www.postgresql.org/docs/18/release-18.html (NOT ENFORCED
 * constraints and virtual generated columns arrive in 18),
 * https://www.postgresql.org/docs/15/release-15.html (NULLS NOT DISTINCT). Storage parameters read the generated catalog's
 * `since` data. The lexicon carries catalogs for majors 14 to 18; a schema that
 * must run on all of them cannot use these, so each is reported as a warning
 * naming the first major that has it.
 */
export const sqlpg115 = checkOf({ id: "SQLPG115", description: "A feature the oldest supported major lacks" }, (ctx, report) => {
  const note = (entity: string, what: string, since: number) =>
    report({ severity: "warning", message: `${entity} uses ${what}, which needs Postgres ${since}; Postgres ${OLDEST_MAJOR} refuses it`, entity });
  for (const o of postgresObjects(ctx)) {
    const target = storageTarget(o);
    if (!target) continue;
    for (const name of storageParams(o.with as string | undefined).keys()) {
      // SQLPG117 asks every view for security_invoker (15), so it is not also a portability finding.
      if (name === "security_invoker") continue;
      const since = rangeOf("storageParameters", `${target}.${name}`)?.since;
      if (since !== undefined && since > OLDEST_MAJOR) note(o.export, `the storage parameter ${name}`, since);
    }
  }
  for (const t of tablesOf(ctx)) {
    for (const c of t.checks) if (c.notEnforced !== undefined) note(t.export, `a NOT ENFORCED / ENFORCED constraint${c.name ? ` ${c.name}` : ""}`, 18);
    for (const fk of t.foreignKeys as Array<{ notEnforced?: boolean; name?: string }>) if (fk.notEnforced !== undefined) note(t.export, `a NOT ENFORCED / ENFORCED foreign key${fk.name ? ` ${fk.name}` : ""}`, 18);
    for (const c of t.columns) if (c.generated?.kind === "virtual") note(t.export, `the virtual generated column ${c.name}`, 18);
    const nulls = [...t.uniques, ...(t.primaryKey ? [t.primaryKey] : [])].some((k) => k.nullsNotDistinct);
    if (nulls) note(t.export, "NULLS NOT DISTINCT", 15);
  }
  for (const i of indexesOf(ctx)) if ((i as { nullsNotDistinct?: boolean }).nullsNotDistinct) note(i.export, "NULLS NOT DISTINCT", 15);
});
