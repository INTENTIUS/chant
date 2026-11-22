/**
 * Which dialect a live read is for. A build holds one dialect, so a read of
 * declared entities follows their types; a read with nothing declared (import)
 * follows the binding: the environment's profile URL (`postgres://` is
 * Postgres, `mysql://` MySQL), else `sql.dialect`, else whichever one of
 * `POSTGRES_URL`, `MYSQL_URL` and `CLICKHOUSE_URL` is set, else ClickHouse,
 * the first dialect.
 */

import type { ChantConfig } from "@intentius/chant/config";
import type { SqlDialect } from "./dialects";
import { isPostgresUrl, loadSqlConfig } from "./postgres/live/bind";
import { isMysqlUrl } from "./mysql/live/bind";

export function dialectOfEntities(entities: ReadonlyMap<string, { entityType: string }> | undefined): SqlDialect {
  for (const e of entities?.values() ?? []) {
    if (e.entityType.startsWith("Postgres::")) return "postgres";
    if (e.entityType.startsWith("MySQL::")) return "mysql";
  }
  return "clickhouse";
}

export function dialectOfBinding(input: {
  environment?: string;
  config?: Pick<ChantConfig, "sql">;
  env?: Record<string, string | undefined>;
}): SqlDialect {
  const env = input.env ?? process.env;
  const profile = input.environment !== undefined ? input.config?.sql?.profiles?.[input.environment] : undefined;
  if (profile) return isPostgresUrl(profile.url) ? "postgres" : isMysqlUrl(profile.url) ? "mysql" : "clickhouse";
  const configured = input.config?.sql?.dialect;
  const named = Array.isArray(configured) ? (configured.length === 1 ? configured[0] : undefined) : configured;
  if (named) return named;
  if (env.POSTGRES_URL && !env.CLICKHOUSE_URL && !env.MYSQL_URL) return "postgres";
  if (env.MYSQL_URL && !env.CLICKHOUSE_URL && !env.POSTGRES_URL) return "mysql";
  return "clickhouse";
}

/** The binding's dialect, loading the project config from `cwd` when none is passed. */
export async function resolveBindingDialect(options: { environment?: string; config?: Pick<ChantConfig, "sql">; cwd?: string; env?: Record<string, string | undefined> }): Promise<SqlDialect> {
  const config = options.config ?? (await loadSqlConfig(options.cwd ?? process.cwd()));
  return dialectOfBinding({ environment: options.environment, config, env: options.env });
}
