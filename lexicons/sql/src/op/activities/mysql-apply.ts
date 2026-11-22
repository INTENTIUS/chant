/**
 * `mysqlApply`, the activity for the MySQL applier (#5449).
 *
 * It reads a build's output (`chant build -o dist/schema.json`), binds the
 * environment's server the way the plan and import do (`sql.profiles.<env>`,
 * else `MYSQL_URL`; ../../mysql/live/bind.ts), connects with mysql2 (an
 * optional peer, loaded only now), and hands the declarations to
 * `applyMysql` (../../mysql/apply/apply.ts), which holds the decisions.
 *
 * The ownership marker is the project's: `ownership.stack` and
 * `ownership.env` from `chant.config.ts`, or `stack` / `ownershipEnv` passed
 * in. Without a stack the apply still runs, stamping only the managed-by
 * marker, and a prune declines (as `not-prunable`).
 */

import { readFileSync } from "node:fs";
import type { ChantConfig } from "@intentius/chant/config";
import { notAttemptedOutcome, resolveOwnershipMarker } from "../../core/apply";
import { classifyMysqlFailure, MysqlBindingError, resolveBoundMysqlTarget, type MysqlTarget } from "../../mysql/live/bind";
import { connectMysql, type MysqlClient, type MysqlEndpoint } from "../../mysql/live/client";
import { applyMysql, buildObjects, declaredObjects, requireDefaultDatabase, type MysqlApplyOptions, type MysqlApplyOutcome } from "../../mysql/apply/apply";

export type { MysqlApplyOutcome } from "../../mysql/apply/apply";

export interface MysqlApplyArgs {
  /** The build's primary output, or a multi-lexicon output holding it under `sql`. */
  buildPath: string;
  /** The chant environment, which selects `sql.profiles.<environment>`. */
  environment?: string;
  /** Drop this project's tables the build no longer declares, and allow column drops. Off by default. */
  prune?: boolean;
  stack?: string;
  ownershipEnv?: string;
  /** Project directory for `chant.config.ts`. Default: the working directory. */
  cwd?: string;
}

/** What a test may inject instead of the project's config, the process env and mysql2. */
export interface MysqlApplyDeps {
  config?: Pick<ChantConfig, "sql" | "ownership">;
  env?: Record<string, string | undefined>;
  log?: (line: string) => void;
  connect?: (endpoint: MysqlEndpoint) => Promise<MysqlClient>;
  readLive?: MysqlApplyOptions["readLive"];
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
 * Apply a sql build to the environment's MySQL server. A server that cannot be
 * bound or reached returns every declared object as not attempted, with the reason.
 */
export async function mysqlApply(args: MysqlApplyArgs, signal?: AbortSignal, deps: MysqlApplyDeps = {}): Promise<MysqlApplyOutcome> {
  const config = deps.config ?? (await loadConfig(args.cwd ?? process.cwd()));
  const marker = resolveOwnershipMarker(args, config, "mysql apply");
  const json = readFileSync(args.buildPath, "utf8");
  const log = deps.log ?? ((line: string) => console.log(line));
  const refs = () => buildObjects(json).map((o) => ({ kind: o.type, name: o.export }));
  let target: MysqlTarget;
  try {
    target = await resolveBoundMysqlTarget({ ...(args.environment !== undefined ? { environment: args.environment } : {}), config: config ?? {}, ...(deps.env ? { env: deps.env } : {}) });
  } catch (err) {
    if (!(err instanceof MysqlBindingError)) throw err;
    return notAttemptedOutcome(refs(), err.unresolved.reason, err.message);
  }
  const declared = declaredObjects(json, requireDefaultDatabase(target, buildObjects(json)));
  let client: MysqlClient;
  try {
    client = await (deps.connect ?? connectMysql)(target.endpoint);
  } catch (err) {
    // A server that refused the credentials was not written to at all; one that cannot be reached is an error.
    const why = classifyMysqlFailure(err);
    if (why.reason === "no-credentials") return notAttemptedOutcome(declared.map((o) => ({ kind: o.type, name: o.key })), "no-credentials", why.detail);
    throw err;
  }
  let outcome: MysqlApplyOutcome;
  try {
    outcome = await applyMysql(client, target, declared, {
      ...(marker ? { marker } : {}),
      ...(args.prune ? { prune: true } : {}),
      ...(signal ? { signal } : {}),
      ...(deps.readLive ? { readLive: deps.readLive } : {}),
      log,
    });
  } finally {
    await client.end();
  }
  for (const a of outcome.applied) log(`${a.action}: ${a.kind}/${a.name}`);
  for (const p of outcome.pruned) log(`pruned: ${p.kind}/${p.name}`);
  for (const n of outcome.notAttempted) log(`not attempted: ${n.kind}/${n.name}: ${n.reason}${n.detail ? ` (${n.detail})` : ""}`);
  return outcome;
}
