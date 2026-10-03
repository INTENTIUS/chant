import { checkOf, indexesOf, tablesOf, type PgIndex } from "./postgres-helpers";

const plain = (i: PgIndex) => (i.method ?? "btree") === "btree" && i.elements.every((e) => e.column);
const keyOf = (i: PgIndex) => `${i.elements.map((e) => e.column).join(",")}|${i.where ?? ""}|${i.include ?? ""}`;

/**
 * SQLPG109: an index that duplicates a constraint's index, or another index.
 *
 * Doc: https://www.postgresql.org/docs/18/indexes-unique.html ("PostgreSQL
 * automatically creates a unique index when a unique constraint or a primary
 * key is defined for a table"), so a second index on the same columns costs
 * every write and serves no query. Two indexes with the same method, columns,
 * INCLUDE and predicate are the same index.
 */
export const sqlpg109 = checkOf({ id: "SQLPG109", description: "An index duplicates a constraint or another index" }, (ctx, report) => {
  const indexes = indexesOf(ctx).filter(plain);
  for (const t of tablesOf(ctx)) {
    const constraints: Array<{ label: string; cols: string }> = [];
    if (t.primaryKey) constraints.push({ label: "its primary key", cols: t.primaryKey.columns.join(",") });
    for (const u of t.uniques) constraints.push({ label: `its unique constraint${u.name ? ` ${u.name}` : ""}`, cols: u.columns.join(",") });
    const mine = indexes.filter((i) => i.tableName === t.sqlName);
    const seen = new Map<string, PgIndex>();
    for (const i of mine) {
      const key = keyOf(i);
      const cols = i.elements.map((e) => e.column).join(",");
      const dup = constraints.find((c) => c.cols === cols && !i.where && !i.include);
      if (dup) {
        report({ severity: "warning", message: `${i.export} (${i.sqlName}) indexes (${cols}) on ${t.sqlName}, which ${dup.label} already indexes`, entity: i.export });
        continue;
      }
      const first = seen.get(key);
      if (first) {
        report({ severity: "warning", message: `${i.export} (${i.sqlName}) duplicates ${first.export} (${first.sqlName}): same columns on ${t.sqlName}`, entity: i.export });
      } else seen.set(key, i);
    }
  }
});
