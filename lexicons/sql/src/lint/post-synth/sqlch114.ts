import { CODECS } from "../../generated/clickhouse";
import { checkOf, codecNames, isTable } from "./clickhouse-helpers";
import { clickhouseObjects } from "./sql-helpers";

/**
 * SQLCH114: a column CODEC names a codec the pinned server does not have.
 *
 * Doc: https://clickhouse.com/docs/sql-reference/statements/create/table#column-compression-codecs.
 * The list is the pinned server's own (`system.codecs`).
 */
export const sqlch114 = checkOf({ id: "SQLCH114", description: "A column codec is not one the pinned server has" }, (ctx, report) => {
  const known = new Set(Object.keys(CODECS).map((n) => n.toLowerCase()));
  for (const t of clickhouseObjects(ctx).filter(isTable)) {
    for (const c of t.columns) {
      if (!c.codec) continue;
      for (const name of codecNames(c.codec)) {
        if (known.has(name.toLowerCase())) continue;
        report({
          severity: "error",
          message: `${t.export} (${t.name}): column ${c.name} uses codec ${name}, which the pinned server does not have`,
          entity: t.export,
        });
      }
    }
  }
});
