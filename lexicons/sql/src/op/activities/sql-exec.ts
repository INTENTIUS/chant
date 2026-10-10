/**
 * `sqlExec` (#3657): run SQL on the environment's database server, the step
 * an `effect()` batch of a sql project is made of.
 *
 *     effect(EffectReceipt("country-202601", { effect: "country/202601", flavor: "existence" }), [
 *       activity("sqlExec", { sql: "ALTER TABLE shop.orders UPDATE country = 'NL' WHERE toYYYYMM(ts) = 202601" }, "atMostOnce"),
 *     ])
 *
 * The server is the one `effect()`'s receipts are kept on
 * (`../../receipts.ts`): `sql.profiles.<env>` for the environment
 * `chant run --env` sets, else `CLICKHOUSE_URL` or `POSTGRES_URL`. `environment`
 * in the arguments names another. On Postgres the SQL runs on a connection of
 * its own with the role's default `search_path`, as one implicit transaction;
 * on ClickHouse, `settings` are sent with the query.
 */

import type { ChantConfig } from "@intentius/chant/config";
import { clickhouseQuery } from "../../clickhouse/http";
import { bindClickHouse } from "../../clickhouse/live/bind";
import { resolveBoundTarget } from "../../postgres/live/bind";
import { connectPostgres } from "../../postgres/live/client";
import { environmentOf, receiptDialect } from "../../receipts";

export interface SqlExecArgs {
  /** The SQL to run: one statement on ClickHouse; one or more on Postgres. */
  sql: string;
  /** The chant environment whose server it runs on. Default: `CHANT_ENV`, then a literal `ownership.env`. */
  environment?: string;
  /** ClickHouse: query settings (`mutations_sync`, `max_execution_time`). */
  settings?: Record<string, string | number>;
  /** The project directory chant.config.ts is read from. Default: the working directory. */
  cwd?: string;
}

export interface SqlExecResult {
  dialect: "clickhouse" | "postgres";
  /** Where the server binding came from: `sql.profiles.prod` or `env CLICKHOUSE_URL`. */
  source: string;
  /** Rows the statement returned (a `SELECT`); 0 for one that returns none. */
  rows: number;
}

/** What a test may inject instead of the project's config and the process env. */
export interface SqlExecDeps {
  config?: Pick<ChantConfig, "sql" | "ownership">;
  env?: Record<string, string | undefined>;
  log?: (line: string) => void;
}

async function loadConfig(cwd: string): Promise<Pick<ChantConfig, "sql" | "ownership"> | undefined> {
  try {
    const { loadChantConfig } = await import("@intentius/chant/config");
    return (await loadChantConfig(cwd)).config;
  } catch {
    return undefined;
  }
}

export async function sqlExec(args: SqlExecArgs, signal?: AbortSignal, deps: SqlExecDeps = {}): Promise<SqlExecResult> {
  if (typeof args?.sql !== "string" || args.sql.trim() === "") throw new Error('sqlExec: needs { sql: "<statement>" }');
  signal?.throwIfAborted();
  const env = deps.env ?? process.env;
  const config = deps.config ?? (await loadConfig(args.cwd ?? process.cwd()));
  const environment = environmentOf(args, config, env);
  const log = deps.log ?? ((line: string) => console.log(line));
  const where = environment !== undefined ? { environment } : {};
  log(args.sql);
  if (receiptDialect(config, environment, env) === "postgres") {
    const target = await resolveBoundTarget({ ...where, config: config ?? {}, env });
    const client = await connectPostgres(target.endpoint, { applicationName: "chant sqlExec" });
    try {
      // The catalog reader's empty search_path is not what a hand-written statement expects.
      await client.query("RESET search_path");
      const rows = await client.query(args.sql);
      return { dialect: "postgres", source: target.source, rows: Array.isArray(rows) ? rows.length : 0 };
    } finally {
      await client.end();
    }
  }
  const target = await bindClickHouse({ ...where, config: config ?? {}, env });
  const settings = args.settings ? Object.fromEntries(Object.entries(args.settings).map(([k, v]) => [k, String(v)])) : undefined;
  const rows = await clickhouseQuery(target.endpoint, args.sql, { ...(settings ? { settings } : {}), ...(signal ? { signal } : {}) });
  return { dialect: "clickhouse", source: target.source, rows: rows.length };
}
