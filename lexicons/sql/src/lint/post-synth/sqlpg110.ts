import { checkOf, indexesOf, leadingColumns, tablesOf } from "./postgres-helpers";

/**
 * SQLPG110: a btree index whose columns are a leading prefix of another index.
 *
 * Doc: https://www.postgresql.org/docs/18/indexes-multicolumn.html ("a
 * multicolumn B-tree index can be used with query conditions that involve any
 * subset of the index's columns, but the index is most efficient when there
 * are constraints on the leading (leftmost) columns"). A plain index on (a)
 * is served by one on (a, b) or by the primary key (a, b). A unique index
 * enforces a rule and is kept.
 */
export const sqlpg110 = checkOf({ id: "SQLPG110", description: "A btree index is a prefix of another index" }, (ctx, report) => {
  const indexes = indexesOf(ctx).filter((i) => (i.method ?? "btree") === "btree");
  for (const t of tablesOf(ctx)) {
    const wider: Array<{ label: string; cols: string[] }> = [];
    if (t.primaryKey) wider.push({ label: "the primary key", cols: t.primaryKey.columns });
    for (const u of t.uniques) wider.push({ label: "a unique constraint", cols: u.columns });
    const mine = indexes.filter((i) => i.tableName === t.sqlName);
    for (const i of mine) if (!i.where) wider.push({ label: i.sqlName, cols: leadingColumns(i) });
    for (const i of mine) {
      if (i.unique || i.where || i.include || !i.elements.every((e) => e.column)) continue;
      const cols = i.elements.map((e) => e.column!);
      const cover = wider.find((w) => w.label !== i.sqlName && w.cols.length > cols.length && cols.every((c, n) => w.cols[n] === c));
      if (!cover) continue;
      report({
        severity: "warning",
        message: `${i.export} (${i.sqlName}) on (${cols.join(", ")}) is a prefix of ${cover.label} (${cover.cols.join(", ")}); drop it`,
        entity: i.export,
      });
    }
  }
});
