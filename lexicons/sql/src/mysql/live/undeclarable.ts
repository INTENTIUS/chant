/**
 * The objects on a live MySQL server of the kinds no declaration holds
 * (#3911), found so import can refuse them by name instead of leaving them
 * out (`../../core/undeclarable.ts`).
 *
 * One `information_schema` query per kind the coverage table marks refused
 * (`../../coverage/mysql.json`), keyed by the row's `kind`, limited to the
 * databases in scope.
 */

import type { MysqlClient } from "./client";
import { KIND_COVERAGE } from "../../coverage";
import type { UndeclarableObject } from "../../core/undeclarable";

/** A query returning `db` and `name`, given the predicate on a database column and its parameters. */
type Probe = (scope: (column: string) => string) => string;

export const MYSQL_PROBES: Readonly<Record<string, Probe>> = {
  "stored function": (scope) => `SELECT ROUTINE_SCHEMA AS db, ROUTINE_NAME AS name FROM information_schema.ROUTINES WHERE ROUTINE_TYPE = 'FUNCTION' AND ${scope("ROUTINE_SCHEMA")}`,
  "stored procedure": (scope) => `SELECT ROUTINE_SCHEMA AS db, ROUTINE_NAME AS name FROM information_schema.ROUTINES WHERE ROUTINE_TYPE = 'PROCEDURE' AND ${scope("ROUTINE_SCHEMA")}`,
  trigger: (scope) => `SELECT TRIGGER_SCHEMA AS db, CONCAT(TRIGGER_NAME, ' ON ', EVENT_OBJECT_TABLE) AS name FROM information_schema.TRIGGERS WHERE ${scope("TRIGGER_SCHEMA")}`,
  event: (scope) => `SELECT EVENT_SCHEMA AS db, EVENT_NAME AS name FROM information_schema.EVENTS WHERE ${scope("EVENT_SCHEMA")}`,
  "partitioned table": (scope) => `SELECT DISTINCT TABLE_SCHEMA AS db, TABLE_NAME AS name FROM information_schema.PARTITIONS WHERE PARTITION_NAME IS NOT NULL AND ${scope("TABLE_SCHEMA")}`,
};

const quote = (s: string) => `'${s.replace(/\\/g, "\\\\").replace(/'/g, "''")}'`;

/**
 * Every object in `databases` of a kind the coverage table refuses, kind by
 * kind in the table's order. A kind the reader may not read is a problem in
 * `unread`, not a pass.
 */
export async function readUndeclarable(client: MysqlClient, databases: readonly string[]): Promise<{ objects: UndeclarableObject[]; unread: string[] }> {
  const objects: UndeclarableObject[] = [];
  const unread: string[] = [];
  if (databases.length === 0) return { objects, unread };
  const scope = (column: string) => `${column} IN (${databases.map(quote).join(", ")})`;
  for (const row of KIND_COVERAGE.mysql) {
    if (row.status !== "refused") continue;
    const probe = MYSQL_PROBES[row.kind];
    if (!probe) throw new Error(`no information_schema query finds a MySQL ${row.kind} (src/mysql/live/undeclarable.ts)`);
    try {
      const rows = await client.query<{ db: string; name: string }>(`/* chant undeclarable: ${row.kind} */ ${probe(scope)} ORDER BY 1, 2`);
      for (const r of rows) objects.push({ kind: row.kind, schema: String(r.db), name: String(r.name) });
    } catch (err) {
      unread.push(`${row.kind}: ${err instanceof Error ? err.message.split("\n")[0] : String(err)}`);
    }
  }
  return { objects, unread };
}
