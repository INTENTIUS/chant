/**
 * The MySQL wire client: `mysql2`, an optional peer dependency, loaded the
 * first time a MySQL server is read, so a project that declares no MySQL
 * never loads it and one that does installs it beside the lexicon
 * (`npm install mysql2`).
 *
 * A session reads and changes the schema with the server's own defaults, one
 * statement at a time (no multiple statements), with dates and big numbers
 * returned as strings so nothing is rounded on the way.
 */

import type { CredentialSource } from "../../token-source";

export interface MysqlEndpoint {
  /** A `mysql://host:port/database` URL, without a password. Its query parameters are passed to the driver as connection options. */
  url: string;
  user?: string;
  password?: string;
  /** Mints the password at each connect, in place of `password` (a profile's `command` token source). */
  token?: CredentialSource;
}

/** What chant reads and writes through: one connection. */
export interface MysqlClient {
  query<T = Record<string, unknown>>(sql: string, params?: readonly unknown[]): Promise<T[]>;
  /** Close the connection. Safe to call twice. */
  end(): Promise<void>;
}

/** A failed statement, with the server's error code (`ER_ACCESS_DENIED_ERROR`) and number when it sent them. */
export class MysqlQueryError extends Error {
  constructor(
    message: string,
    readonly code?: string,
    readonly errno?: number,
  ) {
    super(message);
    this.name = "MysqlQueryError";
  }
}

/** The driver is not installed. */
export class MysqlDriverMissingError extends Error {
  constructor(cause: unknown) {
    super(`reading a MySQL server needs the mysql2 package, which is not installed: npm install mysql2 (${cause instanceof Error ? cause.message.split("\n")[0] : String(cause)})`);
    this.name = "MysqlDriverMissingError";
  }
}

/** The part of `mysql2/promise` chant uses. */
interface Mysql2Connection {
  query(sql: string, values?: unknown): Promise<[unknown, unknown]>;
  end(): Promise<void>;
  on?(event: string, listener: (...args: unknown[]) => void): unknown;
}
interface Mysql2Module {
  createConnection(options: Record<string, unknown>): Promise<Mysql2Connection>;
}

/** The driver's module name. Held in a variable so the lexicon builds and type-checks without it installed. */
const DRIVER = "mysql2/promise";

let loaded: Promise<Mysql2Module> | undefined;

async function driver(): Promise<Mysql2Module> {
  loaded ??= (import(/* @vite-ignore */ DRIVER) as Promise<Mysql2Module & { default?: Mysql2Module }>).then(
    (m) => m.default ?? m,
    (err) => {
      loaded = undefined;
      throw new MysqlDriverMissingError(err);
    },
  );
  return loaded;
}

const wrap = (err: unknown): MysqlQueryError => {
  const e = err as { message?: string; code?: string; errno?: number };
  return new MysqlQueryError(e.message ?? String(err), e.code, e.errno);
};

/** Access-denied errors: the server refused who we are. */
export const CREDENTIAL_CODES: ReadonlySet<string> = new Set(["ER_ACCESS_DENIED_ERROR", "ER_DBACCESS_DENIED_ERROR", "ER_TABLEACCESS_DENIED_ERROR", "ER_SPECIFIC_ACCESS_DENIED_ERROR", "ER_NOT_SUPPORTED_AUTH_MODE"]);

/** Connect to `endpoint`. */
export async function connectMysql(endpoint: MysqlEndpoint): Promise<MysqlClient> {
  const mysql = await driver();
  const url = new URL(endpoint.url);
  url.username = "";
  url.password = "";
  const password = endpoint.token ? await endpoint.token.get() : endpoint.password;
  let conn: Mysql2Connection;
  try {
    conn = await mysql.createConnection({
      uri: url.toString(),
      ...(endpoint.user !== undefined ? { user: endpoint.user } : {}),
      ...(password !== undefined ? { password } : {}),
      multipleStatements: false,
      dateStrings: true,
      supportBigNumbers: true,
      bigNumberStrings: true,
    });
  } catch (err) {
    const wrapped = wrap(err);
    if (endpoint.token && wrapped.code !== undefined && CREDENTIAL_CODES.has(wrapped.code)) endpoint.token.invalidate();
    throw wrapped;
  }
  // A server that goes away emits an error event; the next query fails with it instead of the process crashing.
  conn.on?.("error", () => undefined);
  let ended = false;
  return {
    async query<T>(sql: string, params?: readonly unknown[]): Promise<T[]> {
      try {
        const [rows] = await conn.query(sql, params as unknown[] | undefined);
        return (Array.isArray(rows) ? rows : []) as T[];
      } catch (err) {
        throw wrap(err);
      }
    },
    async end() {
      if (ended) return;
      ended = true;
      await conn.end().catch(() => undefined);
    },
  };
}
