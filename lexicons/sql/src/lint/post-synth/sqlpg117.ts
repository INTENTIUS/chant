import { checkOf, isView, storageParams } from "./postgres-helpers";
import { postgresObjects } from "./sql-helpers";

/**
 * SQLPG117: a view that runs with its owner's privileges.
 *
 * Doc: https://www.postgresql.org/docs/18/sql-createview.html ("by default,
 * access to the underlying base relations referenced in the view is determined
 * by the permissions of the view owner"; with security_invoker = true it is the
 * caller's, and the base tables' row-level security applies to the caller).
 * A view over tables with RLS otherwise hands the owner's view of the rows to
 * every role that can select from it.
 */
export const sqlpg117 = checkOf({ id: "SQLPG117", description: "A view without security_invoker runs with its owner's privileges" }, (ctx, report) => {
  for (const v of postgresObjects(ctx).filter(isView)) {
    const flag = storageParams(v.with).get("security_invoker");
    if (flag === "true" || flag === "on" || flag === "1" || flag === "'true'" || flag === "'on'") continue;
    report({
      severity: "warning",
      message: `${v.export} (${v.sqlName}) does not set security_invoker = true, so it reads its tables as its owner and skips the caller's row-level security`,
      entity: v.export,
    });
  }
});
