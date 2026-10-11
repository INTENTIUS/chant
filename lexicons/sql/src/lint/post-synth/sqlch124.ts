import { checkOf } from "./clickhouse-helpers";
import { clickhouseObjects } from "./sql-helpers";

/**
 * SQLCH124: a table, view or dictionary declares a column twice. The server
 * refuses the `CREATE` ("Column ... already exists").
 */
export const sqlch124 = checkOf({ id: "SQLCH124", description: "A table declares a column twice" }, (ctx, report) => {
  for (const o of clickhouseObjects(ctx)) {
    if (!/^ClickHouse::(Table|View|MaterializedView|Dictionary)$/.test(o.type)) continue;
    const seen = new Set<string>();
    const reported = new Set<string>();
    for (const c of (o.columns ?? []) as Array<{ name: string }>) {
      if (seen.has(c.name) && !reported.has(c.name)) {
        reported.add(c.name);
        report({ severity: "error", message: `${o.export} (${o.name}) declares column ${c.name} twice`, entity: o.export });
      }
      seen.add(c.name);
    }
  }
});
