import { bareName, checkOf, splitTop } from "./clickhouse-helpers";
import { clickhouseObjects, type OutputObject } from "./sql-helpers";

/** The columns a grant can name on an object: each declared column, and `n.a` for a `Nested` column's fields. */
function grantableColumns(o: OutputObject): Set<string> | undefined {
  const columns = (o.columns ?? []) as Array<{ name: string; type?: string }>;
  if (columns.length === 0) return undefined;
  const out = new Set<string>();
  for (const c of columns) {
    out.add(c.name);
    const nested = /^Nested\s*\(([\s\S]*)\)$/.exec(c.type?.trim() ?? "");
    if (nested) {
      for (const field of splitTop(nested[1]!)) {
        const name = /^(`(?:[^`]|``)*`|[A-Za-z_]\w*)/.exec(field.trim())?.[1];
        if (name) out.add(`${c.name}.${bareName(name) ?? name}`);
      }
    }
  }
  return out;
}

/**
 * SQLCH126: a `GRANT` column list names a column the `${}` table does not
 * declare: `GRANT SELECT(kindd) ON ${events}`. The server refuses the grant
 * ("There is no column ...").
 *
 * Only a target the grant interpolates is checked, against the columns it
 * declares; a target written as a plain name, or a view that infers its
 * columns from its SELECT, is left to the server. ClickHouse has no declared
 * `REVOKE`, so a grant is the only column list.
 */
export const sqlch126 = checkOf({ id: "SQLCH126", description: "A GRANT column list names a column the table does not declare" }, (ctx, report) => {
  const objects = clickhouseObjects(ctx);
  const byExport = new Map(objects.map((o) => [o.export, o]));
  for (const g of objects) {
    if (g.type !== "ClickHouse::Grant" || typeof g.on !== "string") continue;
    const target = ((g.dependsOn ?? []) as string[])
      .map((e) => byExport.get(e))
      .find((o) => o !== undefined && (o.sqlName === g.on || (o.database ? `${o.database}.${o.name}` : o.name) === g.on));
    if (!target) continue;
    const columns = grantableColumns(target);
    if (!columns) continue;
    for (const privilege of (g.privileges ?? []) as string[]) {
      const m = /^([A-Za-z_][A-Za-z_ ]*?)\s*\(([\s\S]*)\)\s*$/.exec(privilege.trim());
      if (!m) continue;
      for (const element of splitTop(m[2]!)) {
        const name = bareName(element);
        if (name === undefined || columns.has(name)) continue;
        report({
          severity: "error",
          message: `${g.export}: GRANT ${m[1]!.toUpperCase()}(${name}) ON ${g.on} names column ${name}, which ${target.export} (${target.name}) does not declare`,
          entity: g.export,
        });
      }
    }
  }
});
