import { checkOf, isTable, splitTop } from "./clickhouse-helpers";
import { clickhouseObjects } from "./sql-helpers";

const MAX_VALUES = 100;

/** The literals a CHECK constrains `column` to, for `col IN (...)` and `col = 'a' OR col = 'b'`. */
function allowedValues(expr: string): { column: string; count: number } | undefined {
  const inList = /^\(?\s*(`[^`]+`|[A-Za-z_]\w*)\s+IN\s*\(([\s\S]*)\)\s*\)?$/i.exec(expr.trim());
  if (inList) return { column: inList[1]!.replace(/`/g, ""), count: splitTop(inList[2]!).length };
  const ors = expr.split(/\s+OR\s+/i);
  const eq = ors.map((p) => /^\(?\s*(`[^`]+`|[A-Za-z_]\w*)\s*=\s*'(?:[^'\\]|\\.)*'\s*\)?$/.exec(p.trim()));
  if (ors.length > 1 && eq.every((m) => m && m[1] === eq[0]![1])) return { column: eq[0]![1]!.replace(/`/g, ""), count: ors.length };
  return undefined;
}

/**
 * SQLCH111: a String column a CHECK constrains to a small set of values is not
 * LowCardinality.
 *
 * Doc: https://clickhouse.com/docs/sql-reference/data-types/lowcardinality
 * (LowCardinality dictionary-encodes a column and speeds up SELECT for fewer
 * than about 10,000 distinct values) and
 * https://clickhouse.com/docs/best-practices/select-data-types.
 */
export const sqlch111 = checkOf({ id: "SQLCH111", description: "A String column limited to a few values is not LowCardinality" }, (ctx, report) => {
  for (const t of clickhouseObjects(ctx).filter(isTable)) {
    for (const c of t.constraints ?? []) {
      if (c.kind !== "CHECK") continue;
      const found = allowedValues(c.expr);
      if (!found || found.count > MAX_VALUES) continue;
      const col = t.columns.find((x) => x.name === found.column);
      if (!col?.type || !/^String$/i.test(col.type.trim())) continue;
      report({
        severity: "warning",
        message: `${t.export} (${t.name}): column ${col.name} is String but constraint ${c.name} limits it to ${found.count} values; use LowCardinality(String)`,
        entity: t.export,
      });
    }
  }
});
