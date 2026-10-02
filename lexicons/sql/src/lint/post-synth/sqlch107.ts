import { bareName, checkOf, isTable, splitTop, typeFamily } from "./clickhouse-helpers";
import { clickhouseObjects } from "./sql-helpers";

const DATE_TYPES = new Set(["Date", "Date32", "DateTime", "DateTime64"]);
const TTL_ACTION = /\s+(DELETE|TO\s+DISK|TO\s+VOLUME|RECOMPRESS|GROUP\s+BY|WHERE)\b[\s\S]*$/i;

/**
 * SQLCH107: a TTL expression is a bare column, or a column plus an INTERVAL,
 * and that column is not a Date or DateTime.
 *
 * Doc: https://clickhouse.com/docs/guides/developer/ttl ("The TTL expression
 * must evaluate to Date or DateTime"). Only the two plain forms are judged;
 * a function call is left to the server.
 */
export const sqlch107 = checkOf({ id: "SQLCH107", description: "A TTL expression is built on a column that is not a Date or DateTime" }, (ctx, report) => {
  for (const t of clickhouseObjects(ctx).filter(isTable)) {
    const ttls: Array<{ where: string; expr: string }> = [];
    if (t.ttl) for (const clause of splitTop(t.ttl)) ttls.push({ where: "table TTL", expr: clause.replace(TTL_ACTION, "") });
    for (const c of t.columns) if (c.ttl) ttls.push({ where: `column ${c.name} TTL`, expr: c.ttl.replace(TTL_ACTION, "") });
    for (const { where, expr } of ttls) {
      const plain = /^\s*(`[^`]+`|[A-Za-z_]\w*)\s*(?:[+-]\s*INTERVAL\b[\s\S]*)?$/i.exec(expr);
      if (!plain) continue;
      const name = bareName(plain[1]!);
      const col = name === undefined ? undefined : t.columns.find((c) => c.name === name);
      if (!col?.type) continue;
      const family = typeFamily(col.type);
      if (DATE_TYPES.has(family)) continue;
      report({
        severity: "error",
        message: `${t.export} (${t.name}): ${where} is built on ${col.name}, which is ${col.type}; a TTL expression must be a Date or DateTime`,
        entity: t.export,
      });
    }
  }
});
