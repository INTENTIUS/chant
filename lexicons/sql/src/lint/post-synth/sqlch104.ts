import { baseEngineName, checkOf, engineArguments, isTable, splitTop } from "./clickhouse-helpers";
import { clickhouseObjects } from "./sql-helpers";

/** The engine arguments that name columns, by base engine. */
function columnArguments(engine: string, args: string[]): string[] {
  switch (engine) {
    case "ReplacingMergeTree":
      return args.slice(0, 2);
    case "CollapsingMergeTree":
      return args.slice(0, 1);
    case "VersionedCollapsingMergeTree":
      return args.slice(0, 2);
    case "SummingMergeTree":
    case "CoalescingMergeTree":
      return args.flatMap((a) => splitTop(a.trim().replace(/^\(([\s\S]*)\)$/, "$1")));
    default:
      return [];
  }
}

/**
 * SQLCH104: an engine argument names a column the table does not declare.
 *
 * Docs: the engine pages under
 * https://clickhouse.com/docs/engines/table-engines/mergetree-family/ (the
 * sign, version, is_deleted and summed columns are columns of the table).
 */
export const sqlch104 = checkOf({ id: "SQLCH104", description: "A MergeTree engine argument names a column the table does not declare" }, (ctx, report) => {
  for (const t of clickhouseObjects(ctx).filter(isTable)) {
    if (!t.engine || t.columns.length === 0) continue;
    const declared = new Set(t.columns.map((c) => c.name));
    for (const arg of columnArguments(baseEngineName(t.engine), engineArguments(t.engine))) {
      const name = arg.trim().replace(/^`(.*)`$/, "$1");
      if (!/^[A-Za-z_]\w*$/.test(name) || declared.has(name)) continue;
      report({
        severity: "error",
        message: `${t.export} (${t.name}): ${t.engine.name} names column ${name}, which the table does not declare`,
        entity: t.export,
      });
    }
  }
});
