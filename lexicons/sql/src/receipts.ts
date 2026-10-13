/**
 * The sql lexicon's `effect()` receipt store (#3657): where the receipts of a
 * project that uses only the sql lexicon are kept, on the database server the
 * environment names.
 *
 *     ClickHouse   chant_receipts.receipts
 *     Postgres     chant_receipts.receipts   (or <receiptsSchema>.__chant_receipts)
 *
 * The op activities module binds it as `receiptRead`, `receiptWrite` and
 * `receiptStaleness` (`./op/activities/index.ts`), listed as fallbacks: a
 * project that also configures aws or k8s keeps its receipts in that
 * lexicon's receipt row, in whichever order `lexicons` lists them.
 *
 * Which server: the environment is the one `chant run --env` sets
 * (`CHANT_ENV`), else a literal `ownership.env`. Its `sql.profiles.<env>`
 * binds the server, a `postgres://` URL making it Postgres; with no profile,
 * `CLICKHOUSE_URL` or `POSTGRES_URL`, picked by `sql.dialect`. A receipt's
 * address is `<stack>/<env>/<effect>`, from `ownership.stack` and that
 * environment, the same identity the rebuild's and the column migration's
 * receipts carry (`./core/receipts.ts`).
 *
 * Both tables carry chant's ownership trailer with the `receipts` key in their
 * comment (the Postgres schema too), so plan, import and prune leave them out.
 *
 * A caller that runs its own Op over a server it has already bound (a
 * migration runner, say) passes that server instead: a ClickHouse endpoint,
 * or a Postgres connection, whose receipt writes then commit or roll back
 * with whatever transaction the caller has open on it.
 */

import type { ChantConfig } from "@intentius/chant/config";
import { receiptActivities, type ReceiptActivities, type ReceiptActivityOptions } from "@intentius/chant/op/receipt-store";
import { OWNERSHIP_MANAGED_BY_VALUE } from "@intentius/chant/ownership";
import type { SqlReceiptStore } from "./core/receipts";
import { COMMENT_OWNERSHIP_KEYS, RECEIPTS_TRAILER_KEY } from "./core/ownership";
import type { ClickHouseEndpoint } from "./clickhouse/http";
import type { Topology } from "./clickhouse/topology";
import type { PostgresClient } from "./postgres/live/client";

/** The database (ClickHouse) or schema (Postgres) the receipts are kept in. */
export const SQL_RECEIPTS_SCHEMA = "chant_receipts";
/** The table in it. */
export const SQL_RECEIPTS_TABLE = "receipts";
/** The table's name in a schema of the user's own (`receiptsSchema`), as the column migration names it. */
export const SQL_RECEIPTS_TABLE_BESIDE = "__chant_receipts";

export interface SqlReceiptStoreOptions {
  /** The chant environment. Default: `CHANT_ENV`, then a literal `ownership.env`. */
  environment?: string;
  /** The address's stack segment. Default: `ownership.stack`. */
  stack?: string;
  /** The project directory chant.config.ts is read from. Default: the working directory. */
  cwd?: string;
  /** The project's config, instead of reading chant.config.ts. */
  config?: Pick<ChantConfig, "sql" | "ownership">;
  /** The process environment the bindings and `CHANT_ENV` are read from. Default: `process.env`. */
  env?: Record<string, string | undefined>;
  /** A ClickHouse server already bound: the receipts go there, and no profile is read. */
  clickhouse?: { endpoint: ClickHouseEndpoint; topology?: Topology };
  /**
   * A Postgres connection already open: the receipts go over it, and it is
   * never closed. A write runs inside whatever transaction the caller has
   * open, so it commits or rolls back with it. Call `ensure()` before such a
   * transaction begins, so the receipts table does not roll back with it.
   */
  postgres?: PostgresClient;
  /** Postgres: the schema to keep the receipts in. Default: the profile's `receiptsSchema`, then `chant_receipts`. */
  schema?: string;
  /** Recorded on each receipt written. Default: the current Op run's id. */
  runId?: string;
}

/** The store, and the step a caller with its own transaction takes before one opens. */
export interface SqlServerReceiptStore extends SqlReceiptStore {
  /** Create the receipts table (and database or schema) if it is not there. */
  ensure(): Promise<void>;
  /** Where the receipts are, as resolved: `chant_receipts.receipts` and the server it is on. */
  location(): Promise<{ dialect: "clickhouse" | "postgres"; table: string; source: string; address: string }>;
}

type Config = Pick<ChantConfig, "sql" | "ownership">;

interface Resolved {
  identity: { stack?: string; env?: string };
  open(): Promise<{ store: SqlReceiptStore & { ensure?: () => Promise<void> }; close(): Promise<void> }>;
  dialect: "clickhouse" | "postgres";
  table: string;
  source: string;
}

async function loadConfig(cwd: string): Promise<Config | undefined> {
  try {
    const { loadChantConfig } = await import("@intentius/chant/config");
    return (await loadChantConfig(cwd)).config;
  } catch {
    return undefined;
  }
}

const isPostgresUrl = (url: string): boolean => /^postgres(ql)?:\/\//i.test(url);

/** The dialect an environment's receipts are kept in: its profile's URL, else `sql.dialect`, else whichever server variable is set. */
export function receiptDialect(config: Config | undefined, environment: string | undefined, env: Record<string, string | undefined>): "clickhouse" | "postgres" {
  const profile = environment !== undefined ? config?.sql?.profiles?.[environment] : undefined;
  if (profile) return isPostgresUrl(profile.url) ? "postgres" : "clickhouse";
  const dialects = config?.sql?.dialect === undefined ? [] : Array.isArray(config.sql.dialect) ? config.sql.dialect : [config.sql.dialect];
  if (dialects.length === 1) return dialects[0] === "postgres" ? "postgres" : "clickhouse";
  if (!env.CLICKHOUSE_URL && env.POSTGRES_URL) return "postgres";
  return "clickhouse";
}

/** The run's environment: the option, `CHANT_ENV`, or a literal `ownership.env`. */
export function environmentOf(options: { environment?: string }, config: Pick<ChantConfig, "ownership"> | undefined, env: Record<string, string | undefined>): string | undefined {
  if (options.environment) return options.environment;
  if (env.CHANT_ENV) return env.CHANT_ENV;
  const literal = config?.ownership?.env;
  return typeof literal === "string" ? literal : undefined;
}

async function currentRunId(): Promise<string | undefined> {
  try {
    const { currentOpRun } = await import("@intentius/chant/op");
    return currentOpRun()?.runId;
  } catch {
    return undefined;
  }
}

const receiptsComment = `chant effect receipts [chant ${COMMENT_OWNERSHIP_KEYS.managedBy}=${OWNERSHIP_MANAGED_BY_VALUE} ${RECEIPTS_TRAILER_KEY}=effects]`;

async function resolve(options: SqlReceiptStoreOptions): Promise<Resolved> {
  const env = options.env ?? process.env;
  const needsConfig = options.config === undefined && (!options.stack || (!options.clickhouse && !options.postgres) || !(options.environment || env.CHANT_ENV));
  const config = options.config ?? (needsConfig ? await loadConfig(options.cwd ?? process.cwd()) : undefined);
  const environment = environmentOf(options, config, env);
  const stack = options.stack ?? (config?.ownership && config.ownership.enabled !== false ? config.ownership.stack : undefined);
  const identity = { ...(stack ? { stack } : {}), ...(environment ? { env: environment } : {}) };
  const runId = options.runId ?? (await currentRunId());
  const dialect = options.postgres ? "postgres" : options.clickhouse ? "clickhouse" : receiptDialect(config, environment, env);

  if (dialect === "clickhouse") {
    const { clickhouseReceiptStore } = await import("./clickhouse/rebuild/receipts");
    let endpoint: ClickHouseEndpoint;
    let topology: Topology | undefined;
    let source: string;
    if (options.clickhouse) {
      endpoint = options.clickhouse.endpoint;
      topology = options.clickhouse.topology;
      source = endpoint.url;
    } else {
      const { bindClickHouse } = await import("./clickhouse/live/bind");
      const target = await bindClickHouse({ ...(environment !== undefined ? { environment } : {}), config: config ?? {}, env });
      endpoint = target.endpoint;
      topology = target.topology;
      source = target.source;
    }
    // Created for the environment's topology: ON CLUSTER on a cluster, a Replicated database in the replicated one.
    const store = clickhouseReceiptStore(endpoint, identity, { ...(runId ? { runId } : {}), ...(topology ? { topology } : {}) });
    return {
      identity,
      dialect,
      table: `${SQL_RECEIPTS_SCHEMA}.${SQL_RECEIPTS_TABLE}`,
      source,
      open: async () => ({ store, close: async () => undefined }),
    };
  }

  const { postgresReceiptStore } = await import("./postgres/migrate/receipts");
  const profile = environment !== undefined ? config?.sql?.profiles?.[environment] : undefined;
  const schema = options.schema ?? profile?.receiptsSchema ?? SQL_RECEIPTS_SCHEMA;
  const own = schema === SQL_RECEIPTS_SCHEMA;
  const table = own ? SQL_RECEIPTS_TABLE : SQL_RECEIPTS_TABLE_BESIDE;
  const storeOver = (client: PostgresClient) => {
    const store = postgresReceiptStore(client, schema, identity, { ...(runId ? { runId } : {}), table });
    let ensured = false;
    return {
      ...store,
      async ensure() {
        if (ensured) return;
        // chant's own schema is made here, marked so the catalog leaves it out; a schema of the user's must exist.
        if (own) {
          const [present] = await client.query<{ n: number }>("SELECT count(*)::int AS n FROM pg_catalog.pg_namespace WHERE nspname = $1", [SQL_RECEIPTS_SCHEMA]);
          if (!present?.n) {
            await client.query(`CREATE SCHEMA IF NOT EXISTS ${SQL_RECEIPTS_SCHEMA}`);
            await client.query(`COMMENT ON SCHEMA ${SQL_RECEIPTS_SCHEMA} IS '${receiptsComment.replace(/'/g, "''")}'`);
          }
        }
        await store.ensure();
        ensured = true;
      },
    };
  };
  if (options.postgres) {
    const client = options.postgres;
    const store = storeOver(client);
    return { identity, dialect, table: `${schema}.${table}`, source: "the caller's connection", open: async () => ({ store, close: async () => undefined }) };
  }
  const { resolveBoundTarget } = await import("./postgres/live/bind");
  const { connectPostgres } = await import("./postgres/live/client");
  const target = await resolveBoundTarget({ ...(environment !== undefined ? { environment } : {}), config: config ?? {}, env });
  return {
    identity,
    dialect,
    table: `${schema}.${table}`,
    source: target.source,
    // One connection per read or write: a run's process holds no connection open between steps, and exits when the run ends.
    open: async () => {
      const client = await connectPostgres(target.endpoint, { applicationName: "chant receipts" });
      return { store: storeOver(client), close: () => client.end() };
    },
  };
}

/**
 * The receipt store on the environment's database server. Nothing is read or
 * connected until the first read or write; the environment, the server and
 * the identity are resolved then, once.
 */
export function sqlReceiptStore(options: SqlReceiptStoreOptions = {}): SqlServerReceiptStore {
  let resolved: Promise<Resolved> | undefined;
  const resolvedOnce = () => (resolved ??= resolve(options));
  const using = async <T>(fn: (store: SqlReceiptStore & { ensure?: () => Promise<void> }, r: Resolved) => Promise<T>): Promise<T> => {
    const r = await resolvedOnce();
    const { store, close } = await r.open();
    try {
      return await fn(store, r);
    } finally {
      await close();
    }
  };
  return {
    read: (receipt) => using((s) => s.read(receipt)),
    readAll: (prefix) => using((s) => s.readAll(prefix)),
    async write(receipt, expectation) {
      await using(async (s) => {
        // Made on the first write when it is not there. A caller writing
        // inside its own transaction calls ensure() before opening it, so a
        // rolled-back batch does not take the table with it.
        await s.ensure?.();
        await s.write(receipt, expectation);
      });
    },
    ensure: () => using(async (s) => s.ensure?.()),
    async location() {
      const r = await resolvedOnce();
      const { receiptAddress } = await import("./core/receipts");
      return { dialect: r.dialect, table: r.table, source: r.source, address: receiptAddress(r.identity, "<effect>") };
    },
  };
}

/**
 * The `receiptRead`, `receiptWrite` and `receiptStaleness` activities over
 * {@link sqlReceiptStore}: what the op activities module exports, and what a
 * caller running an Op of `effect()` steps with its own activity map binds.
 */
export function sqlReceiptActivities(options: SqlReceiptStoreOptions = {}, activityOptions?: ReceiptActivityOptions): ReceiptActivities {
  return receiptActivities(sqlReceiptStore(options), activityOptions);
}
