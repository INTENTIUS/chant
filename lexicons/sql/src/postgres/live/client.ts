/**
 * The Postgres wire client: node-postgres (`pg`), loaded the first time a
 * Postgres server is read, so a ClickHouse-only project never loads it.
 *
 * Every session reads the catalog with an empty `search_path`, as `pg_dump`
 * does: `pg_get_*def()` and `format_type()` then qualify every name outside
 * `pg_catalog`, so what a server prints does not depend on the role's own
 * search path.
 */

export interface PostgresEndpoint {
  /** A `postgres://` connection URL, without a password. */
  url: string;
  user?: string;
  password?: string;
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
  if (endpoint.password !== undefined) url.password = encodeURIComponent(endpoint.password);
  const client = new pg.Client({ connectionString: url.toString(), application_name: options.applicationName ?? "chant" });
  // A server that goes away emits an error event; the next query fails with it instead of the process crashing.
  client.on("error", () => undefined);
  try {
    await client.connect();
    await client.query("SELECT pg_catalog.set_config('search_path', '', false)");
  } catch (err) {
    await client.end().catch(() => undefined);
    throw wrap(err);
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
