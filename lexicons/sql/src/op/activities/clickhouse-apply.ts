/**
 * `clickhouseApply`, the Op activity for the ClickHouse applier (#3208), and
 * `toApplyResult`, its projection onto core's apply envelope (#1446).
 *
 * It reads a build's output (`chant build -o dist/schema.json`), binds the
 * environment's server the way observation and import do
 * (`sql.profiles.<env>`, else `CLICKHOUSE_URL`; ../../clickhouse/live/bind.ts),
 * and hands the declarations to `applyClickHouse`
 * (../../clickhouse/apply/apply.ts), which holds the decisions.
 *
 * The ownership marker is the project's: `ownership.stack` and
 * `ownership.env` from `chant.config.ts`, or `stack` / `ownershipEnv` passed
 * in. Without a stack the apply still runs, stamping only the managed-by
 * marker, and a prune declines (as `not-prunable`) rather than drop another
 * project's tables.
 */

import { readFileSync } from "node:fs";
import type { ChantConfig } from "@intentius/chant/config";
import type { OwnershipMarker } from "@intentius/chant/ownership";
import { applyResult, notAttemptedAll, type ApplyResult, type NotAttemptedResource } from "@intentius/chant/apply";
import { bindClickHouse, ClickHouseBindingError, classifyClickHouseFailure } from "../../clickhouse/live/bind";
import { applyClickHouse, declaredObjects, planRefs, type ClickHouseApplyOutcome } from "../../clickhouse/apply/apply";

export type { ClickHouseApplyOutcome } from "../../clickhouse/apply/apply";

export interface ClickHouseApplyArgs {
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
  /** How long to wait for one table's background rewrite. Default: ten minutes. */
  mutationTimeoutMs?: number;
  /** Project directory for `chant.config.ts`. Default: the working directory. */
  cwd?: string;
}

/** What a test (or an embedding caller) may inject instead of the project's config and the process env. */
export interface ClickHouseApplyDeps {
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

/** The marker to stamp and prune by: the arguments, else the project's `ownership` config. */
export function resolveMarker(args: Pick<ClickHouseApplyArgs, "stack" | "ownershipEnv">, config: Pick<ChantConfig, "ownership"> | undefined): OwnershipMarker | undefined {
  const o = config?.ownership;
  const configured = o && o.enabled !== false ? o : undefined;
  const stack = args.stack ?? configured?.stack;
  if (!stack) return undefined;
  const env = args.ownershipEnv ?? (typeof configured?.env === "string" ? configured.env : undefined);
  if (env === undefined && configured?.env !== undefined) {
    throw new Error("clickhouse apply: ownership.env is a build parameter reference, which an apply cannot resolve; pass ownershipEnv");
  }
  return { stack, ...(env ? { env } : {}) };
}

/**
 * Apply a sql build to the environment's ClickHouse server. A server that
 * cannot be bound, or refuses the credentials on the first read, returns
 * every declared object as not attempted, with the reason.
 */
export async function clickhouseApply(args: ClickHouseApplyArgs, signal?: AbortSignal, deps: ClickHouseApplyDeps = {}): Promise<ClickHouseApplyOutcome> {
  const config = deps.config ?? (await loadConfig(args.cwd ?? process.cwd()));
  const marker = resolveMarker(args, config);
  const json = readFileSync(args.buildPath, "utf8");
  const log = deps.log ?? ((line: string) => console.log(line));
  let target;
  try {
    target = await bindClickHouse({ ...(args.environment !== undefined ? { environment: args.environment } : {}), config: config ?? {}, ...(deps.env ? { env: deps.env } : {}) });
  } catch (err) {
    if (!(err instanceof ClickHouseBindingError)) throw err;
    return refused(declaredObjects(json), err.unresolved.reason, err.unresolved.detail);
  }
  const declared = declaredObjects(json, target.defaultDatabase);
  let outcome: ClickHouseApplyOutcome;
  try {
    outcome = await applyClickHouse(target, declared, {
      ...(marker ? { marker } : {}),
      ...(args.prune ? { prune: true } : {}),
      ...(args.mutationTimeoutMs !== undefined ? { mutationTimeoutMs: args.mutationTimeoutMs } : {}),
      ...(signal ? { signal } : {}),
      log,
    });
  } catch (err) {
    // A server that never answered the first read was not written to at all.
    const why = classifyClickHouseFailure(err);
    if (why.reason === "no-credentials" && !(err instanceof Error && err.name === "ClickHouseApplyError")) {
      return { ...refused(declared, "no-credentials", why.detail), target: target.endpoint.url, source: target.source };
    }
    throw err;
  }
  for (const a of outcome.applied) log(`${a.action}: ${a.kind}/${a.name}`);
  for (const p of outcome.pruned) log(`pruned: ${p.kind}/${p.name}`);
  for (const n of outcome.notAttempted) log(`not attempted: ${n.kind}/${n.name}: ${n.reason}${n.detail ? ` (${n.detail})` : ""}`);
  return outcome;

  function refused(objects: ReturnType<typeof declaredObjects>, reason: "no-binding" | "no-credentials", detail: string): ClickHouseApplyOutcome {
    return { target: "", source: "", applied: [], pruned: [], notAttempted: notAttemptedAll(planRefs(objects), reason, detail), failed: [] };
  }
}

/**
 * Project a ClickHouse apply outcome onto core's apply envelope. The outcome
 * keeps what the envelope has no room for: the statements each object took
 * and the server they went to.
 */
export function toApplyResult(outcome: ClickHouseApplyOutcome): ApplyResult {
  return applyResult(
    outcome.applied.map((a) => ({ kind: a.kind, name: a.name, action: a.action, ...(a.physicalId ? { physicalId: a.physicalId } : {}) })),
    outcome.pruned.map((p) => ({ kind: p.kind, name: p.name, deleted: p.deleted })),
    outcome.notAttempted.map((n): NotAttemptedResource => ({ kind: n.kind, name: n.name, reason: n.reason, ...(n.detail ? { detail: n.detail } : {}) })),
  );
}
