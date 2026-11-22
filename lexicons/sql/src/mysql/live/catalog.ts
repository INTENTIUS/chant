/**
 * What a MySQL server holds, read the way `mysqldump --no-data` reads it:
 * the databases, tables and views from `information_schema`, then each
 * object's `SHOW CREATE`, the server's canonical statement, which the plan
 * parses with the same parser as a declaration (`../canonical.ts`) and
 * import writes as one.
 *
 * The server's own databases (`mysql`, `information_schema`,
 * `performance_schema`, `sys`) are never read. A server that reports itself
 * as MariaDB, or as a MySQL major the dialect does not support, is refused
 * before anything is read (`../../spec/mysql-pin.ts`).
 */

import type { MysqlClient } from "./client";
import { classifyMysqlVersion, MYSQL_MAJORS, type MysqlServer } from "../../spec/mysql-pin";
import { MYSQL_ENTITY_TYPES, type MysqlEntityType } from "../entities";
import { quoteIdent } from "../names";

/** One object on the server: its `SHOW CREATE` statement and, for a table, its comment as stored. */
export interface LiveMysqlObject {
  type: MysqlEntityType;
  database?: string;
  name: string;
  statement: string;
  comment?: string;
}

export const SYSTEM_DATABASES: ReadonlySet<string> = new Set(["mysql", "information_schema", "performance_schema", "sys"]);

/** A server the dialect does not read: MariaDB, or a major line with no pin. */
export class MysqlServerError extends Error {
  constructor(readonly server: MysqlServer) {
    super(
      server.flavor === "mariadb"
        ? `the server is MariaDB (${server.version}), and the MySQL dialect reads MySQL ${MYSQL_MAJORS.join(", ")} and Aurora MySQL 3: MariaDB's DDL differs (JSON is LONGTEXT, sequences, system-versioned tables), so its schema is not read as MySQL's`
        : `the server reports version ${server.version}, and the MySQL dialect reads MySQL ${MYSQL_MAJORS.join(", ")} and Aurora MySQL 3`,
    );
    this.name = "MysqlServerError";
  }
}

/** The server's version, refused unless it is a supported MySQL or Aurora MySQL. */
export async function checkServer(client: MysqlClient): Promise<MysqlServer & { flavor: "mysql" | "aurora" }> {
  const rows = await client.query<{ v: string; a?: string | null }>("SELECT VERSION() AS v");
  let version = String(rows[0]?.v ?? "");
  // Aurora MySQL reports its own version through AURORA_VERSION(); VERSION() names the MySQL it is based on.
  if (!/mariadb/i.test(version)) {
    const aurora = await client.query<{ a: string }>("SELECT AURORA_VERSION() AS a").catch(() => []);
    const a = aurora[0]?.a;
    if (typeof a === "string" && /^\d/.test(a)) version = `${version.split(/[-\s]/)[0]!.split(".").slice(0, 2).join(".")}.mysql_aurora.${a}`;
  }
  const server = classifyMysqlVersion(version);
  if (server.flavor !== "mysql" && server.flavor !== "aurora") throw new MysqlServerError(server);
  return server;
}

const placeholders = (n: number) => Array.from({ length: n }, () => "?").join(", ");

/** The databases in scope: `databases` when given, else every one but the server's own. */
export async function databasesInScope(client: MysqlClient, databases?: readonly string[]): Promise<string[]> {
  const rows = databases && databases.length > 0
    ? await client.query<{ name: string }>(`SELECT SCHEMA_NAME AS name FROM information_schema.SCHEMATA WHERE SCHEMA_NAME IN (${placeholders(databases.length)}) ORDER BY SCHEMA_NAME`, databases)
    : await client.query<{ name: string }>("SELECT SCHEMA_NAME AS name FROM information_schema.SCHEMATA ORDER BY SCHEMA_NAME");
  return rows.map((r) => String(r.name)).filter((n) => !SYSTEM_DATABASES.has(n.toLowerCase()));
}

/** The second column of a `SHOW CREATE` row: `Create Table`, `Create View`, `Create Database`. */
function createColumn(row: Record<string, unknown> | undefined, column: string): string {
  const v = row?.[column];
  if (typeof v !== "string") throw new Error(`SHOW CREATE returned no ${column}`);
  return v;
}

/**
 * Every database, table and view in scope, each with its `SHOW CREATE`.
 * `withStatements: false` reads names and comments only, for observation.
 */
export async function readLiveSchema(client: MysqlClient, options: { databases?: readonly string[]; withStatements?: boolean } = {}): Promise<LiveMysqlObject[]> {
  const withStatements = options.withStatements !== false;
  const databases = await databasesInScope(client, options.databases);
  const out: LiveMysqlObject[] = [];
  if (databases.length === 0) return out;
  for (const db of databases) {
    const statement = withStatements ? createColumn((await client.query<Record<string, unknown>>(`SHOW CREATE DATABASE ${quoteIdent(db)}`))[0], "Create Database") : "";
    out.push({ type: MYSQL_ENTITY_TYPES.database, name: db, statement });
  }
  const rows = await client.query<{ db: string; name: string; kind: string; comment: string | null }>(
    `SELECT TABLE_SCHEMA AS db, TABLE_NAME AS name, TABLE_TYPE AS kind, TABLE_COMMENT AS comment FROM information_schema.TABLES WHERE TABLE_SCHEMA IN (${placeholders(databases.length)}) AND TABLE_TYPE IN ('BASE TABLE', 'VIEW') ORDER BY TABLE_SCHEMA, TABLE_NAME`,
    databases,
  );
  for (const r of rows) {
    const db = String(r.db);
    const name = String(r.name);
    const view = r.kind === "VIEW";
    const qualified = `${quoteIdent(db)}.${quoteIdent(name)}`;
    const statement = withStatements
      ? createColumn((await client.query<Record<string, unknown>>(view ? `SHOW CREATE VIEW ${qualified}` : `SHOW CREATE TABLE ${qualified}`))[0], view ? "Create View" : "Create Table")
      : "";
    out.push({
      type: view ? MYSQL_ENTITY_TYPES.view : MYSQL_ENTITY_TYPES.table,
      database: db,
      name,
      statement,
      ...(!view && r.comment ? { comment: String(r.comment) } : {}),
    });
  }
  return out;
}
