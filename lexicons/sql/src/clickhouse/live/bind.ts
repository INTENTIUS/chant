/**
 * Which ClickHouse server a chant environment reads: the config lookup and
 * the binding, shared by observation and live export so both read the same
 * server.
 */

import type { ChantConfig } from "@intentius/chant/config";
import type { UnobservedReason } from "@intentius/chant/observation";
import { ClickHouseQueryError, clickhouseQuery, type ClickHouseEndpoint } from "../http";
import { parseTopology, toTopology, type Topology } from "../topology";
import { credentialSource, POSTGRES_ONLY_TOKEN_SOURCES, TokenSourceError } from "../../token-source";

export interface ClickHouseTarget {
  endpoint: ClickHouseEndpoint;
  /** Where the binding came from: `sql.profiles.prod` or `env CLICKHOUSE_URL`. */
  source: string;
  /** The databases in scope; undefined is every database but the server's own. */
  databases?: string[];
  defaultDatabase: string;
  /**
   * The topology the environment runs (`sql.profiles.<env>.topology`, or
   * `CLICKHOUSE_TOPOLOGY`): what the applier, the plan and the rebuild
   * render their statements for (`../topology.ts`). Undefined: statements
   * as declared.
   */
  topology?: Topology;
  /**
   * Whether chant manages access here (`sql.profiles.<env>.access`, #3716):
   * the declared users, roles, row policies and grants. Off when omitted, as
   * on Postgres, and off for a server bound by `CLICKHOUSE_URL`.
   */
  access?: boolean;
}

export interface UnresolvedTarget {
  reason: "no-binding" | "no-credentials";
  detail: string;
}

export const isUnresolvedTarget = (v: ClickHouseTarget | UnresolvedTarget): v is UnresolvedTarget => "reason" in v;

/**
 * The server an environment reads. Pure: `config` and `env` are passed in.
 *
 * 1. `sql.profiles.<environment>`. A profile naming a credential variable that
 *    is not set is `no-credentials`: the profile said how to authenticate.
 * 2. `CLICKHOUSE_URL`, with `CLICKHOUSE_USER` and `CLICKHOUSE_PASSWORD` when set,
 *    and `CLICKHOUSE_TOPOLOGY` (`single`, `cluster:<name>`, `replicated`,
 *    `cloud`).
 * 3. Otherwise `no-binding`.
 */
export function resolveClickHouseTarget(input: {
  environment?: string;
  config?: Pick<ChantConfig, "sql">;
  env?: Record<string, string | undefined>;
}): ClickHouseTarget | UnresolvedTarget {
  const env = input.env ?? process.env;
  const profile = input.environment !== undefined ? input.config?.sql?.profiles?.[input.environment] : undefined;
  if (profile) {
    const source = `sql.profiles.${input.environment}`;
    const endpoint: ClickHouseEndpoint = { url: profile.url.replace(/\/+$/, "") };
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
        return { reason: "no-credentials", detail: `${source}.password is a ${password.token} token, which only a Postgres server takes; use a command source for ClickHouse` };
      }
      endpoint.token = credentialSource(password, { url: profile.url, ...(endpoint.user !== undefined ? { user: endpoint.user } : {}), env, source: `${source}.password` });
    }
    return {
      endpoint,
      source,
      ...(profile.databases ? { databases: profile.databases } : {}),
      defaultDatabase: profile.defaultDatabase ?? "default",
      ...(profile.topology !== undefined ? { topology: toTopology(profile.topology) } : {}),
      ...(profile.access === true ? { access: true } : {}),
    };
  }
  const url = env.CLICKHOUSE_URL;
  if (!url) {
    const where = input.environment !== undefined ? `sql.profiles.${input.environment} is not declared and ` : "";
    return { reason: "no-binding", detail: `${where}CLICKHOUSE_URL is not set, so there is no ClickHouse server to read` };
  }
  return {
    endpoint: {
      url: url.replace(/\/+$/, ""),
      ...(env.CLICKHOUSE_USER !== undefined ? { user: env.CLICKHOUSE_USER } : {}),
      ...(env.CLICKHOUSE_PASSWORD !== undefined ? { password: env.CLICKHOUSE_PASSWORD } : {}),
    },
    source: "env CLICKHOUSE_URL",
    defaultDatabase: "default",
    ...(env.CLICKHOUSE_TOPOLOGY ? { topology: parseTopology(env.CLICKHOUSE_TOPOLOGY) } : {}),
  };
}

/** A target that could not be resolved. */
export class ClickHouseBindingError extends Error {
  constructor(readonly unresolved: UnresolvedTarget) {
    super(unresolved.detail);
    this.name = "ClickHouseBindingError";
  }
}

export interface BindOptions {
  environment?: string;
  /** The project's config; loaded from `cwd` when omitted. */
  config?: Pick<ChantConfig, "sql">;
  cwd?: string;
  env?: Record<string, string | undefined>;
}

async function loadConfig(cwd: string): Promise<Pick<ChantConfig, "sql"> | undefined> {
  try {
    const { loadChantConfig } = await import("@intentius/chant/config");
    return (await loadChantConfig(cwd)).config;
  } catch {
    // No project config: the environment variables still bind.
    return undefined;
  }
}

/** Resolve the environment's server. Throws {@link ClickHouseBindingError} when there is none. */
export async function bindClickHouse(options: BindOptions = {}): Promise<ClickHouseTarget> {
  const config = options.config ?? (await loadConfig(options.cwd ?? process.cwd()));
  const target = resolveClickHouseTarget({ environment: options.environment, config, env: options.env });
  if (isUnresolvedTarget(target)) throw new ClickHouseBindingError(target);
  return target;
}

/** What a failed bind or read means, in the observation vocabulary. */
export function classifyClickHouseFailure(err: unknown): { reason: UnobservedReason; detail: string } {
  if (err instanceof ClickHouseBindingError) return { reason: err.unresolved.reason, detail: err.unresolved.detail };
  if (err instanceof TokenSourceError) return { reason: "no-credentials", detail: err.message };
  if (err instanceof ClickHouseQueryError) {
    // 516 AUTHENTICATION_FAILED and 497 ACCESS_DENIED arrive as 401/403 or in the message.
    if (err.status === 401 || err.status === 403 || /AUTHENTICATION_FAILED|ACCESS_DENIED|Code: 516|Code: 497/.test(err.serverMessage)) {
      return { reason: "no-credentials", detail: `${err.message} (the server refused the credentials)` };
    }
    return { reason: "read-failed", detail: err.message };
  }
  return { reason: "read-failed", detail: err instanceof Error ? err.message.split("\n")[0]! : String(err) };
}

/** `SELECT version()` on the target. */
export async function serverVersion(target: ClickHouseTarget): Promise<string> {
  const [row] = await clickhouseQuery<{ v: string }>(target.endpoint, "SELECT version() AS v");
  return row?.v ?? "";
}
