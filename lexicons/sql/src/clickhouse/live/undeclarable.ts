/**
 * The objects on a live ClickHouse server of the kinds no declaration holds
 * (#3911), found so import can refuse them by name instead of leaving them
 * out (`../../core/undeclarable.ts`).
 *
 * One `system.*` query per kind the coverage table marks refused
 * (`../../coverage/clickhouse.json`), keyed by the row's `kind`. A kind whose
 * row is flipped to declared is no longer asked about.
 *
 * What the server's configuration files define (`storage = 'users_xml'`, a
 * named collection whose source is the config, an executable function) is
 * the server's, not a schema's, and is left out; so is what is in a database
 * out of scope. A server-wide object (a quota, a settings profile, a
 * workload) is always looked for.
 */

import { clickhouseQuery } from "../http";
import type { ClickHouseTarget } from "./bind";
import { SYSTEM_DATABASES } from "./catalog";
import { KIND_COVERAGE } from "../../coverage";
import type { UndeclarableObject } from "../../core/undeclarable";

const quote = (s: string) => `'${s.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;

/** A query returning `database` (empty for a server-wide object) and `name`; `scope` is the predicate on a database column. */
type Probe = (scope: (column: string) => string) => string;

const serverWide = (table: string, where = "1") => () => `SELECT '' AS database, name FROM system.${table} WHERE ${where}`;
const SQL_DEFINED = "storage != 'users_xml'";

export const CLICKHOUSE_PROBES: Readonly<Record<string, Probe>> = {
  "non-SQL function": serverWide("functions", "origin NOT IN ('System', 'SQLUserDefined', 'ExecutableUserDefined')"),
  "HTTP handler": serverWide("handlers"),
  "masking policy": (scope) => `SELECT database, short_name || ' ON ' || table AS name FROM system.masking_policies WHERE ${SQL_DEFINED} AND ${scope("database")}`,
  "named collection": serverWide("named_collections", "source = 'SQL'"),
  quota: serverWide("quotas", SQL_DEFINED),
  "workload resource": serverWide("resources"),
  "settings profile": serverWide("settings_profiles", SQL_DEFINED),
  "window view": (scope) => `SELECT database, name FROM system.tables WHERE engine = 'WindowView' AND NOT is_temporary AND ${scope("database")}`,
  workload: serverWide("workloads"),
};

/**
 * Every object in scope of a kind the coverage table refuses, kind by kind
 * in the table's order, each by database then name. A kind the reader may
 * not read (no grant on its `system` table) is a problem in `unread`, not a
 * pass.
 */
export async function readUndeclarable(target: ClickHouseTarget): Promise<{ objects: UndeclarableObject[]; unread: string[] }> {
  const scope = (column: string) =>
    target.databases ? `${column} IN (${target.databases.map(quote).join(", ")})` : `${column} NOT IN (${[...SYSTEM_DATABASES].map(quote).join(", ")})`;
  const objects: UndeclarableObject[] = [];
  const unread: string[] = [];
  for (const row of KIND_COVERAGE.clickhouse) {
    if (row.status !== "refused") continue;
    const probe = CLICKHOUSE_PROBES[row.kind];
    if (!probe) throw new Error(`no system table query finds a ClickHouse ${row.kind} (src/clickhouse/live/undeclarable.ts)`);
    try {
      const rows = await clickhouseQuery<{ database: string; name: string }>(target.endpoint, `/* chant undeclarable: ${row.kind} */ SELECT database, name FROM (${probe(scope)}) ORDER BY database, name`);
      for (const r of rows) objects.push({ kind: row.kind, ...(r.database ? { schema: r.database } : {}), name: r.name });
    } catch (err) {
      unread.push(`${row.kind}: ${err instanceof Error ? err.message.split("\n")[0] : String(err)}`);
    }
  }
  return { objects, unread };
}
