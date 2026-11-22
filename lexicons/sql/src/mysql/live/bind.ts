/**
 * Which MySQL server a chant environment reads and applies to: the binding
 * shared by observation, import, the plan and the applier.
 *
 * 1. `sql.profiles.<environment>` with a `mysql://` URL. Its user and
 *    password are named by environment variable, or the password is minted by
 *    a `command` token source. A profile naming a variable that is not set is
 *    `no-credentials`.
 * 2. `MYSQL_URL`, with `MYSQL_USER` and `MYSQL_PASSWORD` when set.
 * 3. Otherwise `no-binding`.
 *
 * The database an unqualified declaration lives in is the profile's
 * `defaultDatabase`, else the database the URL names (`mysql://db:3306/shop`).
 */

import type { ChantConfig } from "@intentius/chant/config";
import type { UnobservedReason } from "@intentius/chant/observation";
import { connectMysql, CREDENTIAL_CODES, MysqlDriverMissingError, MysqlQueryError, type MysqlClient, type MysqlEndpoint } from "./client";
import { credentialSource, POSTGRES_ONLY_TOKEN_SOURCES, TokenSourceError } from "../../token-source";
import { loadSqlConfig } from "../../postgres/live/bind";

export { loadSqlConfig };

export interface MysqlTarget {
  endpoint: MysqlEndpoint;
  /** Where the binding came from: `sql.profiles.prod` or `env MYSQL_URL`. */
  source: string;
  /** The databases in scope; undefined is every database but the server's own. */
  databases?: string[];
  /** The database an unqualified declaration lives in; undefined when neither the profile nor the URL names one. */
  defaultDatabase?: string;
}

export interface UnresolvedMysqlTarget {
  reason: "no-binding" | "no-credentials";
  detail: string;
}

export const isUnresolvedMysqlTarget = (v: MysqlTarget | UnresolvedMysqlTarget): v is UnresolvedMysqlTarget => "reason" in v;

/** Whether a URL names a MySQL server. */
export const isMysqlUrl = (url: string): boolean => /^mysql:\/\//i.test(url);

/** The database a `mysql://host/db` URL names, if any. */
export function urlDatabase(url: string): string | undefined {
  try {
    const path = decodeURIComponent(new URL(url).pathname.replace(/^\//, ""));
    return path === "" ? undefined : path;
  } catch {
    return undefined;
  }
}

/** The server an environment reads. Pure: `config` and `env` are passed in. */
export function resolveMysqlTarget(input: { environment?: string; config?: Pick<ChantConfig, "sql">; env?: Record<string, string | undefined> }): MysqlTarget | UnresolvedMysqlTarget {
  const env = input.env ?? process.env;
  const profile = input.environment !== undefined ? input.config?.sql?.profiles?.[input.environment] : undefined;
  if (profile && isMysqlUrl(profile.url)) {
    const source = `sql.profiles.${input.environment}`;
    const endpoint: MysqlEndpoint = { url: profile.url };
    if (profile.user) {
      const value = env[profile.user.env];
      if (value === undefined) return { reason: "no-credentials", detail: `${source}.user names ${profile.user.env}, which is not set` };
      endpoint.user = value;
    }
    const password = profile.password;
    if (password && "env" in password) {
      const value = env[password.env];
      if (value === undefined) return { reason: "no-credentials", detail: `${source}.password names ${password.env}, which is not set` };
      endpoint.password = value;
    } else if (password) {
      if (POSTGRES_ONLY_TOKEN_SOURCES.has(password.token)) {
        return { reason: "no-credentials", detail: `${source}.password is a ${password.token} token, which chant mints for a Postgres server only; give a MySQL profile a password variable or a command token` };
      }
      endpoint.token = credentialSource(password, { url: profile.url, ...(endpoint.user !== undefined ? { user: endpoint.user } : {}), env, source: `${source}.password` });
    }
    const defaultDatabase = profile.defaultDatabase ?? urlDatabase(profile.url);
    return {
      endpoint,
      source,
      ...(profile.databases ? { databases: profile.databases } : {}),
      ...(defaultDatabase !== undefined ? { defaultDatabase } : {}),
    };
  }
  const url = env.MYSQL_URL;
  if (!url) {
    const where = input.environment !== undefined ? `sql.profiles.${input.environment} names no mysql:// server and ` : "";
    return { reason: "no-binding", detail: `${where}MYSQL_URL is not set, so there is no MySQL server to read` };
  }
  const defaultDatabase = urlDatabase(url);
  return {
    endpoint: {
      url,
      ...(env.MYSQL_USER !== undefined ? { user: env.MYSQL_USER } : {}),
      ...(env.MYSQL_PASSWORD !== undefined ? { password: env.MYSQL_PASSWORD } : {}),
    },
    source: "env MYSQL_URL",
    ...(defaultDatabase !== undefined ? { defaultDatabase } : {}),
  };
}

/** A target that could not be resolved. */
export class MysqlBindingError extends Error {
  constructor(readonly unresolved: UnresolvedMysqlTarget) {
    super(unresolved.detail);
    this.name = "MysqlBindingError";
  }
}

export interface MysqlBindOptions {
  environment?: string;
  /** The project's config; loaded from `cwd` when omitted. */
  config?: Pick<ChantConfig, "sql">;
  cwd?: string;
  env?: Record<string, string | undefined>;
  /** Connect with this instead of mysql2 (tests). */
  connect?: (endpoint: MysqlEndpoint) => Promise<MysqlClient>;
}

/** Resolve the environment's server. Throws {@link MysqlBindingError} when there is none. */
export async function resolveBoundMysqlTarget(options: MysqlBindOptions = {}): Promise<MysqlTarget> {
  const config = options.config ?? (await loadSqlConfig(options.cwd ?? process.cwd()));
  const target = resolveMysqlTarget({ environment: options.environment, config, env: options.env });
  if (isUnresolvedMysqlTarget(target)) throw new MysqlBindingError(target);
  return target;
}

/** Resolve the environment's server and connect to it. The caller ends the client. */
export async function bindMysql(options: MysqlBindOptions = {}): Promise<{ target: MysqlTarget; client: MysqlClient }> {
  const target = await resolveBoundMysqlTarget(options);
  const client = await (options.connect ?? connectMysql)(target.endpoint);
  return { target, client };
}

/** What a failed bind or read means, in the observation vocabulary. */
export function classifyMysqlFailure(err: unknown): { reason: UnobservedReason; detail: string } {
  if (err instanceof MysqlBindingError) return { reason: err.unresolved.reason, detail: err.unresolved.detail };
  if (err instanceof TokenSourceError) return { reason: "no-credentials", detail: err.message };
  if (err instanceof MysqlDriverMissingError) return { reason: "read-failed", detail: err.message };
  if (err instanceof MysqlQueryError && err.code !== undefined && CREDENTIAL_CODES.has(err.code)) {
    return { reason: "no-credentials", detail: `${err.message} (the server refused the credentials, ${err.code})` };
  }
  return { reason: "read-failed", detail: err instanceof Error ? err.message.split("\n")[0]! : String(err) };
}
