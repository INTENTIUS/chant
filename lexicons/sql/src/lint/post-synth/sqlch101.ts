import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
import { DATABASE_ENGINES, TABLE_ENGINES, CLICKHOUSE_VERSION } from "../../generated/clickhouse";
import { clickhouseObjects } from "./sql-helpers";

/**
 * SQLCH101: a table, materialized view or database names an engine the pinned
 * ClickHouse server does not have.
 *
 * The engine list is the pinned server's own (`system.table_engines`,
 * `system.database_engines`), so a misspelling (`MergTree`) or an engine a
 * release removed fails here, at build, rather than at `CREATE` against a
 * server.
 */
export const sqlch101: PostSynthCheck = {
  id: "SQLCH101",
  description: "A ClickHouse object names an engine the pinned server does not have",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    const out: PostSynthDiagnostic[] = [];
    for (const obj of clickhouseObjects(ctx)) {
      const engine = obj.engine?.name;
      if (!engine) continue;
      const known = obj.type === "ClickHouse::Database" ? engine in DATABASE_ENGINES : engine in TABLE_ENGINES;
      if (known) continue;
      out.push({
        checkId: "SQLCH101",
        severity: "error",
        message: `${obj.export} (${obj.name}) uses engine "${engine}", which ClickHouse ${CLICKHOUSE_VERSION} does not have`,
        entity: obj.export,
        lexicon: "sql",
      });
    }
    return out;
  },
};
