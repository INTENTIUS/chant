import { MERGE_TREE_SETTINGS } from "../../generated/clickhouse";
import { checkOf, isMergeTree } from "./clickhouse-helpers";
import { clickhouseObjects } from "./sql-helpers";

/**
 * SQLCH118: a MergeTree SETTINGS entry the pinned server does not have.
 *
 * Doc: https://clickhouse.com/docs/operations/settings/merge-tree-settings.
 * The list is the pinned server's `system.merge_tree_settings`; an unknown
 * name (usually a typo, or a setting a later release added) fails the CREATE
 * with "Unknown setting".
 */
export const sqlch118 = checkOf({ id: "SQLCH118", description: "A MergeTree setting is not one the pinned server has" }, (ctx, report) => {
  const known = MERGE_TREE_SETTINGS as Record<string, unknown>;
  for (const o of clickhouseObjects(ctx)) {
    if (o.type !== "ClickHouse::Table" || !isMergeTree(o.engine)) continue;
    for (const name of Object.keys((o.settings as Record<string, string> | undefined) ?? {})) {
      if (name in known) continue;
      report({
        severity: "error",
        message: `${o.export} (${o.name}) sets ${name}, which ClickHouse 26.8 does not have as a MergeTree setting`,
        entity: o.export,
      });
    }
  }
});
