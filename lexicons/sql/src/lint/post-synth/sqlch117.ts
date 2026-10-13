import { MERGE_TREE_SETTINGS } from "../../generated/clickhouse";
import { checkOf, isMergeTree } from "./clickhouse-helpers";
import { clickhouseObjects } from "./sql-helpers";

/**
 * SQLCH117: a MergeTree SETTINGS entry the pinned server marks obsolete.
 *
 * Doc: https://clickhouse.com/docs/operations/settings/merge-tree-settings.
 * `system.merge_tree_settings` flags it with tier Obsolete; the server accepts
 * it and ignores it, so the table does not behave as the setting suggests.
 */
export const sqlch117 = checkOf({ id: "SQLCH117", description: "A MergeTree setting is obsolete at the pinned server" }, (ctx, report) => {
  const specs = MERGE_TREE_SETTINGS as Record<string, { obsolete: boolean } | undefined>;
  for (const o of clickhouseObjects(ctx)) {
    if (!isMergeTree(o.engine) && o.type !== "ClickHouse::MaterializedView") continue;
    for (const name of Object.keys((o.settings as Record<string, string> | undefined) ?? {})) {
      if (!specs[name]?.obsolete) continue;
      report({
        severity: "warning",
        message: `${o.export} (${o.name}) sets ${name}, which is obsolete and does nothing at ClickHouse 26.8; remove it`,
        entity: o.export,
      });
    }
  }
});
