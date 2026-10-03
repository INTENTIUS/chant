import { STORAGE_PARAMETERS } from "../../generated/postgres";
import { checkOf, rangeOf, storageParams, storageTarget, targetMajor } from "./postgres-helpers";
import { postgresObjects } from "./sql-helpers";

/**
 * SQLPG114: a storage parameter the object's kind does not accept at the
 * target major (`postgresMajor` in the output).
 *
 * Doc: https://www.postgresql.org/docs/18/sql-createtable.html#SQL-CREATETABLE-STORAGE-PARAMETERS
 * (and the CREATE INDEX, CREATE VIEW and CREATE MATERIALIZED VIEW pages). The
 * server refuses an unrecognized parameter at CREATE. The accepted names and
 * the relation kinds they apply to come from the generated catalog, whose
 * since/until data says which majors have each one: a parameter removed
 * before the target major is reported as removed.
 */
export const sqlpg114 = checkOf({ id: "SQLPG114", description: "A storage parameter the object's kind or the target major does not accept" }, (ctx, report) => {
  const major = targetMajor(ctx);
  const specs = STORAGE_PARAMETERS as Record<string, { targets: readonly string[] } | undefined>;
  for (const o of postgresObjects(ctx)) {
    const target = storageTarget(o);
    if (!target) continue;
    for (const raw of storageParams(o.with as string | undefined).keys()) {
      if (raw.startsWith("toast.")) continue;
      const spec = specs[raw];
      if (!spec) {
        report({ severity: "error", message: `${o.export} (${o.sqlName}) sets ${raw}, which is not a Postgres ${major} storage parameter`, entity: o.export });
        continue;
      }
      const range = rangeOf("storageParameters", `${target}.${raw}`);
      if (!spec.targets.includes(target)) {
        report({ severity: "error", message: `${o.export} (${o.sqlName}) sets ${raw}, which applies to ${spec.targets.join(", ")} and not to a ${target}`, entity: o.export });
      } else if (range?.until !== undefined && range.until < major) {
        report({ severity: "error", message: `${o.export} (${o.sqlName}) sets ${raw}, which Postgres removed after ${range.until}`, entity: o.export });
      }
    }
  }
});
