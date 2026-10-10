/**
 * The Postgres wire client: node-postgres (`pg`), loaded the first time a
 * Postgres server is read, so a ClickHouse-only project never loads it.
 *
 * Every session reads the catalog with an empty `search_path`, as `pg_dump`
 * does: `pg_get_*def()` and `format_type()` then qualify every name outside
 * `pg_catalog`, so what a server prints does not depend on the role's own
 * search path.
 */

import type { CredentialSource } from "../../token-source";

export interface PostgresEndpoint {
  /** A `postgres://` connection URL, without a password. */
  url: string;
  user?: string;
  password?: string;
  /** Mints the password at each connect, in place of `password` (a profile's token source, #3685). */
  token?: CredentialSource;
}

/** What chant reads and writes through: one connection. */
export interface PostgresClient {
  query<T = Record<string, unknown>>(sql: string, params?: readonly unknown[]): Promise<T[]>;
  /** Close the connection. Safe to call twice. */
  end(): Promise<void>;
}

/** A failed statement, with the server's SQLSTATE when it sent one. */
export class PostgresQueryError extends Error {
  constructor(
    message: string,
    readonly code?: string,
    readonly position?: number,
  ) {
    super(message);
    this.name = "PostgresQueryError";
  }
}

type PgModule = typeof import("pg");

let loaded: Promise<PgModule> | undefined;

async function pgModule(): Promise<PgModule> {
  loaded ??= import("pg").then((m) => ((m as unknown as { default?: PgModule }).default ?? m) as PgModule);
  return loaded;
}

const wrap = (err: unknown): PostgresQueryError => {
  const e = err as { message?: string; code?: string; position?: string };
  return new PostgresQueryError(e.message ?? String(err), e.code, e.position !== undefined ? Number(e.position) : undefined);
};

/** Connect to `endpoint` and set the catalog-reading session up. */
export async function connectPostgres(endpoint: PostgresEndpoint, options: { applicationName?: string } = {}): Promise<PostgresClient> {
  const pg = await pgModule();
  // node-postgres lets the connection string's fields win over the config's, so the credentials go into the URL.
  const url = new URL(endpoint.url);
  if (endpoint.user !== undefined) url.username = encodeURIComponent(endpoint.user);
  const password = endpoint.token ? await endpoint.token.get() : endpoint.password;
  if (password !== undefined) url.password = encodeURIComponent(password);
  const client = new pg.Client({ connectionString: url.toString(), application_name: options.applicationName ?? "chant" });
  // A server that goes away emits an error event; the next query fails with it instead of the process crashing.
  client.on("error", () => undefined);
  try {
    await client.connect();
    await client.query("SELECT pg_catalog.set_config('search_path', '', false)");
  } catch (err) {
    await client.end().catch(() => undefined);
    const wrapped = wrap(err);
    // A refused token is not reused: the next connect mints another.
    if (endpoint.token && (wrapped.code === "28P01" || wrapped.code === "28000")) endpoint.token.invalidate();
    throw wrapped;
  }
  let ended = false;
  return {
    async query<T>(sql: string, params?: readonly unknown[]): Promise<T[]> {
      try {
        const r = await client.query(sql, params as unknown[] | undefined);
        return r.rows as T[];
      } catch (err) {
        throw wrap(err);
      }
    },
    async end() {
      if (ended) return;
      ended = true;
      await client.end().catch(() => undefined);
    },
  };
}

/** SQLSTATE lock_not_available: `lock_timeout` passed while a statement waited for a lock. */
export const SQLSTATE_LOCK_NOT_AVAILABLE = "55P03";

/** The `lock_timeout` a statement waits under when the profile sets none (`sql.profiles.<env>.lockTimeoutMs`): the applier's and the catalog reader's. */
export const DEFAULT_LOCK_TIMEOUT_MS = 5_000;

/** A session holding ACCESS EXCLUSIVE on a relation: what a catalog read waits behind. */
export interface LockHolder {
  pid: number;
  relation: string;
  application?: string;
  state?: string;
  /** Seconds since the holder's transaction began. */
  seconds?: number;
  query?: string;
}

/**
 * The sessions holding ACCESS EXCLUSIVE on a relation in the current database,
 * other than this one. Only that mode conflicts with the ACCESS SHARE a
 * catalog function (`pg_get_viewdef()`, `pg_get_indexdef()`) takes. Empty when
 * the lookup itself fails.
 */
export async function accessExclusiveHolders(client: PostgresClient): Promise<LockHolder[]> {
  try {
    const rows = await client.query<{ pid: number; relation: string; application: string | null; state: string | null; seconds: number | null; query: string | null }>(
      `SELECT l.pid, l.relation::pg_catalog.regclass::text AS relation, a.application_name AS application, a.state,
              (EXTRACT(EPOCH FROM pg_catalog.now() - a.xact_start))::int AS seconds, pg_catalog.left(a.query, 120) AS query
         FROM pg_catalog.pg_locks l LEFT JOIN pg_catalog.pg_stat_activity a ON a.pid = l.pid
        WHERE l.locktype = 'relation' AND l.granted AND l.mode = 'AccessExclusiveLock'
          AND l.pid <> pg_catalog.pg_backend_pid()
          AND l.database = (SELECT oid FROM pg_catalog.pg_database WHERE datname = pg_catalog.current_database())
        ORDER BY l.pid, 2 LIMIT 10`,
    );
    return rows.map((r) => ({
      pid: Number(r.pid),
      relation: r.relation,
      ...(r.application ? { application: r.application } : {}),
      ...(r.state ? { state: r.state } : {}),
      ...(r.seconds !== null && r.seconds !== undefined ? { seconds: Number(r.seconds) } : {}),
      ...(r.query ? { query: r.query.replace(/\s+/g, " ").trim() } : {}),
    }));
  } catch {
    return [];
  }
}

/** One line naming the lock holders, for a message. */
export function describeLockHolders(holders: readonly LockHolder[]): string {
  if (holders.length === 0) return "no session holds ACCESS EXCLUSIVE now; the lock was released after the wait";
  return holders
    .map((h) => {
      const about = [h.application ? `application ${JSON.stringify(h.application)}` : "", h.state ?? "", h.seconds !== undefined ? `transaction open ${h.seconds}s` : "", h.query ? `last statement: ${h.query}` : ""].filter(Boolean);
      return `${h.relation} is held in ACCESS EXCLUSIVE by pid ${h.pid}${about.length > 0 ? ` (${about.join(", ")})` : ""}`;
    })
    .join("; ");
}

/**
 * A client for catalog reads: the session's `lock_timeout` is `lockTimeoutMs`
 * (0 waits without limit, as Postgres does), so a read that needs a table
 * another session holds in ACCESS EXCLUSIVE (a long `ALTER TABLE`, `LOCK
 * TABLE`) fails after the wait instead of hanging. The failure names the
 * relation and the pid holding it.
 */
export async function withCatalogLockTimeout(client: PostgresClient, lockTimeoutMs: number = DEFAULT_LOCK_TIMEOUT_MS): Promise<PostgresClient> {
  await client.query("SELECT pg_catalog.set_config('lock_timeout', $1, false)", [`${lockTimeoutMs}ms`]);
  return {
    async query<T>(sql: string, params?: readonly unknown[]): Promise<T[]> {
      try {
        return await client.query<T>(sql, params);
      } catch (err) {
        if (!(err instanceof PostgresQueryError) || err.code !== SQLSTATE_LOCK_NOT_AVAILABLE) throw err;
        const holders = describeLockHolders(await accessExclusiveHolders(client));
        throw new PostgresQueryError(
          `${err.message.split("\n")[0]}: the catalog read waited ${lockTimeoutMs}ms for a lock; ${holders}. Wait for that transaction to finish, or raise sql.profiles.<env>.lockTimeoutMs`,
          err.code,
          err.position,
        );
      }
    },
    end: () => client.end(),
  };
}
