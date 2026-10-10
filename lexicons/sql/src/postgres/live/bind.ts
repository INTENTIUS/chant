/**
 * Which Postgres server a chant environment reads: the config lookup and the
 * binding, shared by observation, live export and the plan, so all of them
 * read the same server.
 */

import type { ChantConfig } from "@intentius/chant/config";
import type { UnobservedReason } from "@intentius/chant/observation";
import { connectPostgres, PostgresQueryError, type PostgresClient, type PostgresEndpoint } from "./client";
import type { PostgresProvider } from "../providers/types";

export interface PostgresTarget {
  endpoint: PostgresEndpoint;
  /** Where the binding came from: `sql.profiles.prod` or `env POSTGRES_URL`. */
  source: string;
  /** The schemas in scope; undefined is every schema but the server's own. */
  schemas?: string[];
  /** The schema an unqualified declaration lives in. */
  defaultSchema: string;
  /** The managed service the server runs on (`sql.profiles.<env>.provider`, else `sql.provider`); its own objects read as foreign. */
  provider?: PostgresProvider;
  /** The apply's timeouts the profile sets (`lockTimeoutMs`, `statementTimeoutMs`, `scanTimeoutMs`); the applier's defaults otherwise. */
  timeouts?: { lockTimeoutMs?: number; statementTimeoutMs?: number; scanTimeoutMs?: number };
  /** Whether chant manages access here (`sql.profiles.<env>.access`): policies, row-level security, the declared roles, grants and default privileges. */
  access?: boolean;
}

export interface UnresolvedTarget {
  reason: "no-binding" | "no-credentials";
  detail: string;
}

export const isUnresolvedTarget = (v: PostgresTarget | UnresolvedTarget): v is UnresolvedTarget => "reason" in v;

/** Whether a URL names a Postgres server. */
export const isPostgresUrl = (url: string): boolean => /^postgres(ql)?:\/\//i.test(url);

/** A URL with any password in it taken out, for a message. */
export const redactUrl = (url: string): string => url.replace(/^(postgres(?:ql)?:\/\/[^:/@]+):[^@]*@/i, "$1:***@");

/**
 * The server an environment reads. Pure: `config` and `env` are passed in.
 *
 * 1. `sql.profiles.<environment>` with a `postgres://` URL. A profile naming a
 *    credential variable that is not set is `no-credentials`.
 * 2. `POSTGRES_URL`, with `POSTGRES_USER` and `POSTGRES_PASSWORD` when set.
 * 3. Otherwise `no-binding`.
 */
export function resolvePostgresTarget(input: {
  environment?: string;
  config?: Pick<ChantConfig, "sql">;
  env?: Record<string, string | undefined>;
}): PostgresTarget | UnresolvedTarget {
  const env = input.env ?? process.env;
  const profile = input.environment !== undefined ? input.config?.sql?.profiles?.[input.environment] : undefined;
  const provider = (profile && isPostgresUrl(profile.url) ? profile.provider : undefined) ?? input.config?.sql?.provider;
  const withProvider = <T extends object>(t: T): T => (provider ? { ...t, provider } : t);
  if (profile && isPostgresUrl(profile.url)) {
    const source = `sql.profiles.${input.environment}`;
    const endpoint: PostgresEndpoint = { url: profile.url };
    for (const key of ["user", "password"] as const) {
      const ref = profile[key];
      if (!ref) continue;
      const value = env[ref.env];
      if (value === undefined) return { reason: "no-credentials", detail: `${source}.${key} names ${ref.env}, which is not set` };
      endpoint[key] = value;
    }
    const timeouts = Object.fromEntries(
      (["lockTimeoutMs", "statementTimeoutMs", "scanTimeoutMs"] as const).filter((k) => profile[k] !== undefined).map((k) => [k, profile[k]]),
    );
    return withProvider({
      endpoint,
      source,
      ...(profile.schemas ? { schemas: profile.schemas } : {}),
      defaultSchema: profile.defaultSchema ?? "public",
      ...(Object.keys(timeouts).length > 0 ? { timeouts } : {}),
      ...(profile.access === true ? { access: true } : {}),
    });
  }
  const url = env.POSTGRES_URL;
  if (!url) {
    const where = input.environment !== undefined ? `sql.profiles.${input.environment} names no postgres:// server and ` : "";
    return { reason: "no-binding", detail: `${where}POSTGRES_URL is not set, so there is no Postgres server to read` };
  }
  return withProvider({
    endpoint: {
      url,
      ...(env.POSTGRES_USER !== undefined ? { user: env.POSTGRES_USER } : {}),
      ...(env.POSTGRES_PASSWORD !== undefined ? { password: env.POSTGRES_PASSWORD } : {}),
    },
    source: "env POSTGRES_URL",
    defaultSchema: "public",
  });
}

/** A target that could not be resolved. */
export class PostgresBindingError extends Error {
  constructor(readonly unresolved: UnresolvedTarget) {
    super(unresolved.detail);
    this.name = "PostgresBindingError";
  }
}

export interface BindOptions {
  environment?: string;
  /** The project's config; loaded from `cwd` when omitted. */
  config?: Pick<ChantConfig, "sql">;
  cwd?: string;
  env?: Record<string, string | undefined>;
  /** Connect with this instead of node-postgres (tests). */
  connect?: (endpoint: PostgresEndpoint) => Promise<PostgresClient>;
}

export async function loadSqlConfig(cwd: string): Promise<Pick<ChantConfig, "sql"> | undefined> {
  try {
    const { loadChantConfig } = await import("@intentius/chant/config");
    return (await loadChantConfig(cwd)).config;
  } catch {
    // No project config: the environment variables still bind.
    return undefined;
  }
}

/** Resolve the environment's server. Throws {@link PostgresBindingError} when there is none. */
export async function resolveBoundTarget(options: BindOptions = {}): Promise<PostgresTarget> {
  const config = options.config ?? (await loadSqlConfig(options.cwd ?? process.cwd()));
  const target = resolvePostgresTarget({ environment: options.environment, config, env: options.env });
  if (isUnresolvedTarget(target)) throw new PostgresBindingError(target);
  return target;
}

/** Resolve the environment's server and connect to it. The caller ends the client. */
export async function bindPostgres(options: BindOptions = {}): Promise<{ target: PostgresTarget; client: PostgresClient }> {
  const target = await resolveBoundTarget(options);
  const client = await (options.connect ?? connectPostgres)(target.endpoint);
  return { target, client };
}

/** SQLSTATEs that mean the server refused who we are: invalid_authorization_specification, invalid_password, insufficient_privilege. */
const CREDENTIAL_STATES = new Set(["28000", "28P01", "42501"]);

/** What a failed bind or read means, in the observation vocabulary. */
export function classifyPostgresFailure(err: unknown): { reason: UnobservedReason; detail: string } {
  if (err instanceof PostgresBindingError) return { reason: err.unresolved.reason, detail: err.unresolved.detail };
  if (err instanceof PostgresQueryError && err.code && CREDENTIAL_STATES.has(err.code)) {
    return { reason: "no-credentials", detail: `${err.message} (the server refused the credentials, SQLSTATE ${err.code})` };
  }
  return { reason: "read-failed", detail: err instanceof Error ? err.message.split("\n")[0]! : String(err) };
}
