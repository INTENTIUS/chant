import { baseEngineName, checkOf, columnByName, engineArguments, isNullableType, isTable, typeFamily } from "./clickhouse-helpers";
import { clickhouseObjects } from "./sql-helpers";

const VERSION_TYPES = new Set(["UInt8", "UInt16", "UInt32", "UInt64", "UInt128", "UInt256", "Date", "DateTime", "DateTime64"]);

/** engine -> the argument positions that name a column, and the types the engine accepts there. */
const SPECIAL: Record<string, Array<{ role: string; index: number; accepts: (family: string) => boolean; wants: string }>> = {
  ReplacingMergeTree: [
    { role: "version", index: 0, accepts: (f) => VERSION_TYPES.has(f), wants: "UInt*, Date, DateTime or DateTime64" },
    { role: "is_deleted", index: 1, accepts: (f) => f === "UInt8", wants: "UInt8" },
  ],
  CollapsingMergeTree: [{ role: "sign", index: 0, accepts: (f) => f === "Int8", wants: "Int8" }],
  VersionedCollapsingMergeTree: [
    { role: "sign", index: 0, accepts: (f) => f === "Int8", wants: "Int8" },
    { role: "version", index: 1, accepts: (f) => VERSION_TYPES.has(f), wants: "UInt*, Date, DateTime or DateTime64" },
  ],
};

/**
 * SQLCH103: the version, sign or is_deleted column of a Replacing, Collapsing
 * or VersionedCollapsing table has a type the engine does not accept.
 *
 * Docs: https://clickhouse.com/docs/engines/table-engines/mergetree-family/replacingmergetree
 * (version: UInt*, Date, DateTime or DateTime64; is_deleted: UInt8) and
 * .../collapsingmergetree, .../versionedcollapsingmergetree (sign: Int8).
 */
export const sqlch103 = checkOf({ id: "SQLCH103", description: "An engine's version, sign or is_deleted column has an unsupported type" }, (ctx, report) => {
  for (const t of clickhouseObjects(ctx).filter(isTable)) {
    if (!t.engine) continue;
    const roles = SPECIAL[baseEngineName(t.engine)];
    if (!roles) continue;
    const args = engineArguments(t.engine);
    for (const r of roles) {
      const arg = args[r.index];
      const col = arg ? columnByName(t, arg.replace(/^`|`$/g, "")) : undefined;
      if (!col?.type) continue;
      if (!isNullableType(col.type) && r.accepts(typeFamily(col.type))) continue;
      report({
        severity: "error",
        message: `${t.export} (${t.name}): ${r.role} column ${col.name} is ${col.type}; ${t.engine.name} takes ${r.wants}`,
        entity: t.export,
      });
    }
  }
});
