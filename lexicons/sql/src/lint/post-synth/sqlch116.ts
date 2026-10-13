import { checkOf, isAnyView } from "./clickhouse-helpers";
import { clickhouseObjects } from "./sql-helpers";

/**
 * SQLCH116: a view declared SQL SECURITY DEFINER without a DEFINER.
 *
 * Doc: https://clickhouse.com/docs/sql-reference/statements/create/view#sql-security
 * (the DEFINER clause names the user whose privileges the view's SELECT runs
 * with). Without it the view's access is decided by whoever happened to run
 * the CREATE, so the same declaration grants different access per environment.
 */
export const sqlch116 = checkOf({ id: "SQLCH116", description: "A view is SQL SECURITY DEFINER with no DEFINER" }, (ctx, report) => {
  for (const v of clickhouseObjects(ctx).filter(isAnyView)) {
    const security = v.security ?? "";
    if (!/SQL\s+SECURITY\s+DEFINER/i.test(security) || /\bDEFINER\s*=/i.test(security)) continue;
    report({
      severity: "warning",
      message: `${v.export} (${v.name}) is SQL SECURITY DEFINER with no DEFINER = <user>; name the user whose privileges it runs with`,
      entity: v.export,
    });
  }
});
