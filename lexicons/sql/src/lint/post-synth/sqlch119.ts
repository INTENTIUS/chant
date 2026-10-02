import { DATABASE_ENGINES, TABLE_ENGINES } from "../../generated/clickhouse";
import { checkOf } from "./clickhouse-helpers";
import { clickhouseObjects } from "./sql-helpers";

/**
 * SQLCH119: an engine the pinned catalog describes as deprecated or experimental.
 *
 * Docs: https://clickhouse.com/docs/engines/database-engines/ordinary (the
 * legacy, deprecated default replaced by Atomic) and the engine pages the
 * snapshot's summaries come from (`This engine is experimental`,
 * ExperimentalBadge). The words are read from the committed catalog snapshot,
 * so a pin move changes the verdict.
 */
export const sqlch119 = checkOf({ id: "SQLCH119", description: "An object uses a deprecated or experimental engine" }, (ctx, report) => {
  const tables = TABLE_ENGINES as Record<string, { summary: string } | undefined>;
  const databases = DATABASE_ENGINES as Record<string, { summary: string } | undefined>;
  for (const o of clickhouseObjects(ctx)) {
    const name = o.engine?.name;
    if (!name) continue;
    const isDatabase = o.type === "ClickHouse::Database";
    const summary = (isDatabase ? databases : tables)[name]?.summary ?? "";
    const deprecated = /\bdeprecated\b/i.test(summary);
    const experimental = isDatabase ? /ExperimentalBadge/.test(summary) : /\b(is|are) (an )?experimental\b/i.test(summary);
    if (!deprecated && !experimental) continue;
    report({
      severity: "warning",
      message: `${o.export} (${o.name}) uses the ${deprecated ? "deprecated" : "experimental"} engine ${name}`,
      entity: o.export,
    });
  }
});
