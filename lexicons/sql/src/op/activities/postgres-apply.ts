/**
 * `postgresApply`, the Op activity for the Postgres applier (#3280), and
 * `toApplyResult`, its projection onto core's apply envelope (#1446), the
 * same projection the ClickHouse applier exports.
 *
 * It reads a build's output (`chant build -o dist/schema.json`), binds the
 * environment's server the way observation, import and `chant sql plan` do
 * (`sql.profiles.<env>`, else `POSTGRES_URL`; ../../postgres/live/bind.ts),
 * connects with node-postgres (loaded only now), and hands the declarations
 * to `applyPostgres` (../../postgres/apply/apply.ts), which holds the
 * decisions.
 *
 * The server's major is the build output's `postgresMajor` (#3315), else
 * `sql.postgresMajor`, else the newest pinned one.
 *
 * The ownership marker is the project's: `ownership.stack` and
 * `ownership.env` from `chant.config.ts`, or `stack` / `ownershipEnv` passed
 * in. Without a stack the apply still runs, stamping only the managed-by
 * marker, and a prune declines (as `not-prunable`) rather than drop another
 * project's objects. The timeouts are the profile's, else the applier's
 * defaults, and an argument overrides either.
 */

import { readFileSync } from "node:fs";
import type { ChantConfig } from "@intentius/chant/config";
import { notAttemptedOutcome, resolveOwnershipMarker } from "../../core/apply";
import { classifyPostgresFailure, PostgresBindingError, resolveBoundTarget, type PostgresTarget } from "../../postgres/live/bind";
import { connectPostgres, type PostgresClient, type PostgresEndpoint } from "../../postgres/live/client";
import {
  DEFAULT_POSTGRES_APPLY_TIMEOUTS,
  applyPostgres,
  declaredObjects,
  planRefs,
  type PostgresApplyOptions,
  type PostgresApplyOutcome,
  type PostgresApplyTimeouts,
} from "../../postgres/apply/apply";

export type { PostgresApplyOutcome } from "../../postgres/apply/apply";

export interface PostgresApplyArgs {
  /** The build's primary output (`chant build src --lexicon sql -o dist/schema.json`), or a multi-lexicon output holding it under `sql`. */
  buildPath: string;
  /** The chant environment, which selects `sql.profiles.<environment>`. */
  environment?: string;
  /**
   * Drop this project's objects the build no longer declares (only those
   * whose comment carries its marker, stack and env), and allow column drops.
   * Destructive, so off by default.
   */
  prune?: boolean;
  /** Ownership stack. Default: `ownership.stack` in `chant.config.ts`. */
  stack?: string;
  /** Ownership env. Default: `ownership.env` in `chant.config.ts` (a literal; a `{ param }` reference needs this). */
  ownershipEnv?: string;
  /** `lock_timeout` for every statement, in ms. Default: the profile's `lockTimeoutMs`, else 5000. */
  lockTimeoutMs?: number;
  /** `statement_timeout` for a catalog-only statement, in ms. Default: the profile's `statementTimeoutMs`, else 60000. */
  statementTimeoutMs?: number;
  /** `statement_timeout` for a statement that reads or rewrites rows, in ms; 0 is no limit. Default: the profile's `scanTimeoutMs`, else 0. */
  scanTimeoutMs?: number;
  /** Project directory for `chant.config.ts`. Default: the working directory. */
  cwd?: string;
}

/** What a test (or an embedding caller) may inject instead of the project's config, the process env and node-postgres. */
export interface PostgresApplyDeps {
  config?: Pick<ChantConfig, "sql" | "ownership">;
  env?: Record<string, string | undefined>;
  log?: (line: string) => void;
  connect?: (endpoint: PostgresEndpoint) => Promise<PostgresClient>;
  /** Passed to the applier: a catalog reader and a server-normalization stand-in for a fake server. */
  readLive?: PostgresApplyOptions["readLive"];
  serverNormalize?: PostgresApplyOptions["serverNormalize"];
}

/** The build output's `postgresMajor`, when it carries one. */
export function buildMajor(json: string): number | undefined {
  try {
    const raw = JSON.parse(json) as { postgresMajor?: unknown; sql?: { postgresMajor?: unknown } };
    const m = raw.sql && typeof raw.sql === "object" ? raw.sql.postgresMajor : raw.postgresMajor;
    return typeof m === "number" ? m : undefined;
  } catch {
    return undefined;
  }
}

async function loadConfig(cwd: string): Promise<Pick<ChantConfig, "sql" | "ownership"> | undefined> {
  try {
    const { loadChantConfig } = await import("@intentius/chant/config");
    return (await loadChantConfig(cwd)).config;
  } catch {
    return undefined;
  }
}

/**
 * Apply a sql build to the environment's Postgres server. A server that
 * cannot be bound, or refuses the credentials when connecting, returns every
 * declared object as not attempted, with the reason.
 */
export async function postgresApply(args: PostgresApplyArgs, signal?: AbortSignal, deps: PostgresApplyDeps = {}): Promise<PostgresApplyOutcome> {
  const config = deps.config ?? (await loadConfig(args.cwd ?? process.cwd()));
  const marker = resolveOwnershipMarker(args, config, "postgres apply");
  const json = readFileSync(args.buildPath, "utf8");
  const log = deps.log ?? ((line: string) => console.log(line));
  const timeouts: Partial<PostgresApplyTimeouts> = {
    ...(args.lockTimeoutMs !== undefined ? { lockTimeoutMs: args.lockTimeoutMs } : {}),
    ...(args.statementTimeoutMs !== undefined ? { statementTimeoutMs: args.statementTimeoutMs } : {}),
    ...(args.scanTimeoutMs !== undefined ? { scanTimeoutMs: args.scanTimeoutMs } : {}),
  };

  // The major the build targets (#3315): what an apply does can differ by major (SET EXPRESSION from 17, SET STORAGE DEFAULT from 16).
  const major = buildMajor(json) ?? config?.sql?.postgresMajor;

  let target: PostgresTarget;
  try {
    target = await resolveBoundTarget({ ...(args.environment !== undefined ? { environment: args.environment } : {}), config: config ?? {}, ...(deps.env ? { env: deps.env } : {}) });
  } catch (err) {
    if (!(err instanceof PostgresBindingError)) throw err;
    return refused(declaredObjects(json), undefined, err.unresolved.reason, err.unresolved.detail);
  }
  const declared = declaredObjects(json, target.defaultSchema);

  let client: PostgresClient;
  try {
    client = await (deps.connect ?? ((e) => connectPostgres(e, { applicationName: "chant apply" })))(target.endpoint);
  } catch (err) {
    // A server that refused the credentials was not written to at all; one that cannot be reached is an error.
    const why = classifyPostgresFailure(err);
    if (why.reason === "no-credentials") return refused(declared, target, "no-credentials", why.detail);
    throw err;
  }
  let outcome: PostgresApplyOutcome;
  try {
    outcome = await applyPostgres(client, target, declared, {
      ...(marker ? { marker } : {}),
      ...(args.prune ? { prune: true } : {}),
      timeouts,
      ...(major !== undefined ? { major } : {}),
      ...(signal ? { signal } : {}),
      ...(deps.readLive ? { readLive: deps.readLive } : {}),
      ...(deps.serverNormalize ? { serverNormalize: deps.serverNormalize } : {}),
      log,
    });
  } catch (err) {
    // The first read is the catalog read: a refusal there means nothing was written.
    const why = classifyPostgresFailure(err);
    if (why.reason === "no-credentials" && !(err instanceof Error && err.name === "PostgresApplyError")) {
      return refused(declared, target, "no-credentials", why.detail);
    }
    throw err;
  } finally {
    await client.end();
  }
  for (const a of outcome.applied) log(`${a.action}: ${a.kind}/${a.name}`);
  for (const p of outcome.pruned) log(`pruned: ${p.kind}/${p.name}`);
  for (const n of outcome.notAttempted) log(`not attempted: ${n.kind}/${n.name}: ${n.reason}${n.detail ? ` (${n.detail})` : ""}`);
  return outcome;

  function refused(objects: ReturnType<typeof declaredObjects>, t: PostgresTarget | undefined, reason: "no-binding" | "no-credentials", detail: string): PostgresApplyOutcome {
    return {
      ...notAttemptedOutcome(planRefs(objects), reason, detail),
      ...(t ? { target: t.endpoint.url, source: t.source } : {}),
      timeouts: { ...DEFAULT_POSTGRES_APPLY_TIMEOUTS, ...t?.timeouts, ...timeouts },
      statements: [],
      transactions: [],
    };
  }
}
