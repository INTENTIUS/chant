/**
 * A fake MySQL server for tests (#5449): answers the catalog reads chant
 * sends (`../live/catalog.ts`, `../live/undeclarable.ts`) from recorded
 * `SHOW CREATE` statements, and records every other statement it is sent
 * without running it. It never opens a connection.
 */

import type { MysqlClient } from "../live/client";
import { MysqlQueryError } from "../live/client";

export interface FakeObject {
  kind: "database" | "table" | "view";
  database?: string;
  name: string;
  /** The `SHOW CREATE` statement, as a MySQL 8.0 server prints it. */
  statement: string;
  /** A table's comment as `information_schema.TABLES` holds it. */
  comment?: string;
}

export interface FakeServerOptions {
  /** `VERSION()`. Default `8.0.40`. */
  version?: string;
  /** `AURORA_VERSION()`, for an Aurora MySQL server. */
  aurora?: string;
  objects?: FakeObject[];
  /** Rows the undeclarable probes find, by the table they read: `ROUTINES`, `TRIGGERS`, `EVENTS`, `PARTITIONS`. */
  probes?: Partial<Record<"FUNCTION" | "PROCEDURE" | "TRIGGERS" | "EVENTS" | "PARTITIONS", Array<{ db: string; name: string }>>>;
  /** A statement matching one of these fails with the server's error. */
  fail?: Array<{ match: RegExp; message: string; code?: string }>;
}

export interface FakeServer extends MysqlClient {
  /** Every statement that was not a catalog read, in order. */
  readonly sent: string[];
  ended: boolean;
}

const unq = (s: string) => s.replace(/^`(.*)`$/, "$1").replace(/``/g, "`");

export function fakeMysqlServer(options: FakeServerOptions = {}): FakeServer {
  const objects = options.objects ?? [];
  const sent: string[] = [];
  const server: FakeServer = {
    sent,
    ended: false,
    async query<T>(sql: string, params?: readonly unknown[]): Promise<T[]> {
      const rows = (r: unknown[]) => r as T[];
      if (/^SELECT VERSION\(\)/i.test(sql)) return rows([{ v: options.version ?? "8.0.40" }]);
      if (/^SELECT AURORA_VERSION\(\)/i.test(sql)) {
        if (options.aurora === undefined) throw new MysqlQueryError("FUNCTION AURORA_VERSION does not exist", "ER_SP_DOES_NOT_EXIST", 1305);
        return rows([{ a: options.aurora }]);
      }
      if (/information_schema\.SCHEMATA/i.test(sql)) {
        const names = objects.filter((o) => o.kind === "database").map((o) => o.name);
        const wanted = params && params.length > 0 ? names.filter((n) => params.includes(n)) : names;
        return rows(wanted.sort().map((name) => ({ name })));
      }
      if (/^SHOW CREATE DATABASE/i.test(sql)) {
        const name = unq(sql.replace(/^SHOW CREATE DATABASE\s+/i, "").trim());
        const o = objects.find((x) => x.kind === "database" && x.name === name);
        if (!o) throw new MysqlQueryError(`Unknown database '${name}'`, "ER_BAD_DB_ERROR", 1049);
        return rows([{ Database: name, "Create Database": o.statement }]);
      }
      if (/FROM information_schema\.TABLES/i.test(sql)) {
        const dbs = new Set((params ?? []).map(String));
        return rows(
          objects
            .filter((o) => o.kind !== "database" && dbs.has(o.database ?? ""))
            .sort((a, b) => `${a.database}.${a.name}`.localeCompare(`${b.database}.${b.name}`))
            .map((o) => ({ db: o.database, name: o.name, kind: o.kind === "view" ? "VIEW" : "BASE TABLE", comment: o.kind === "view" ? "VIEW" : (o.comment ?? "") })),
        );
      }
      const show = /^SHOW CREATE (TABLE|VIEW)\s+(`(?:[^`]|``)*`|[^\s.`]+)\.(`(?:[^`]|``)*`|\S+)/i.exec(sql);
      if (show) {
        const db = unq(show[2]!);
        const name = unq(show[3]!);
        const o = objects.find((x) => x.kind !== "database" && x.database === db && x.name === name);
        if (!o) throw new MysqlQueryError(`Table '${db}.${name}' doesn't exist`, "ER_NO_SUCH_TABLE", 1146);
        return rows([o.kind === "view" ? { View: name, "Create View": o.statement } : { Table: name, "Create Table": o.statement }]);
      }
      if (/chant undeclarable/.test(sql)) {
        const p = options.probes ?? {};
        if (/ROUTINE_TYPE = 'FUNCTION'/.test(sql)) return rows(p.FUNCTION ?? []);
        if (/ROUTINE_TYPE = 'PROCEDURE'/.test(sql)) return rows(p.PROCEDURE ?? []);
        if (/information_schema\.TRIGGERS/.test(sql)) return rows(p.TRIGGERS ?? []);
        if (/information_schema\.EVENTS/.test(sql)) return rows(p.EVENTS ?? []);
        if (/information_schema\.PARTITIONS/.test(sql)) return rows(p.PARTITIONS ?? []);
        return rows([]);
      }
      const failure = options.fail?.find((f) => f.match.test(sql));
      if (failure) throw new MysqlQueryError(failure.message, failure.code);
      sent.push(sql);
      return rows([]);
    },
    async end() {
      server.ended = true;
    },
  };
  return server;
}
