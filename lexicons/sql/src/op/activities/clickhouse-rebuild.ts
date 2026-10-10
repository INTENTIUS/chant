/**
 * The rebuild migration's activities (#3198), one per step of
 * `ClickHouseRebuildOp` (`../../clickhouse/rebuild/op.ts`). Each takes the
 * same arguments, reads the build's declaration of the table and binds the
 * environment's server the way the applier does (`./clickhouse-apply.ts`),
 * then runs its step (`../../clickhouse/rebuild/`), which re-reads the server.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { ChantConfig } from "@intentius/chant/config";
import { currentOpRun, parseDuration } from "@intentius/chant/op";
import { bindClickHouse } from "../../clickhouse/live/bind";
import { declaredObjects } from "../../clickhouse/apply/apply";
import { declaredTable, observeRebuild, rebuildPlanDigest, RebuildRefusal } from "../../clickhouse/rebuild/observe";
import { backfill, type BackfillDeps, type BackfillResult } from "../../clickhouse/rebuild/backfill";
import { RebuildVerificationError, verifyRebuild, type VerifyResult } from "../../clickhouse/rebuild/verify";
import {
  compensate,
  createNewTable,
  dropOldTable,
  retainPlan,
  startDualWrite,
  swapTables,
  type CompensateResult,
  type CreateResult,
  type DropResult,
  type DualWriteResult,
  type RebuildRun,
  type RetainResult,
  type SwapResult,
} from "../../clickhouse/rebuild/steps";
import type { ClickHouseRebuildArgs } from "../../clickhouse/rebuild/op";
import { CLASSIFIER_RULES } from "../../clickhouse/plan/rules";
import { resolveMarker } from "./clickhouse-apply";

export type { ClickHouseRebuildArgs } from "../../clickhouse/rebuild/op";

/** What a test (or an embedding caller) may inject instead of the project's config and the process env. */
export interface ClickHouseRebuildDeps {
  config?: Pick<ChantConfig, "sql" | "ownership">;
  env?: Record<string, string | undefined>;
  log?: (line: string) => void;
  backfill?: BackfillDeps;
}

async function loadConfig(cwd: string): Promise<Pick<ChantConfig, "sql" | "ownership"> | undefined> {
  try {
    const { loadChantConfig } = await import("@intentius/chant/config");
    return (await loadChantConfig(cwd)).config;
  } catch {
    return undefined;
  }
}

/** Bind the server and read the declaration: what every step starts from. */
export async function rebuildRun(args: ClickHouseRebuildArgs, signal: AbortSignal | undefined, deps: ClickHouseRebuildDeps): Promise<RebuildRun> {
  const cwd = args.cwd ?? process.cwd();
  const config = deps.config ?? (await loadConfig(cwd));
  const marker = resolveMarker(args, config);
  const target = await bindClickHouse({ ...(args.environment !== undefined ? { environment: args.environment } : {}), config: config ?? {}, ...(deps.env ? { env: deps.env } : {}) });
  const declared = declaredTable(declaredObjects(readFileSync(resolve(cwd, args.buildPath), "utf8"), target.defaultDatabase, target.topology), args.table);
  const runId = currentOpRun()?.runId;
  return {
    target,
    declared,
    ...(marker ? { marker } : {}),
    dualWrite: args.dualWrite,
    retainMs: parseDuration(args.retain ?? "7d"),
    ...(args.mutationTimeout ? { mutationTimeoutMs: parseDuration(args.mutationTimeout) } : {}),
    ...(args.replicaTimeout ? { replicaTimeoutMs: parseDuration(args.replicaTimeout) } : {}),
    log: deps.log ?? ((line: string) => console.log(line)),
    ...(signal ? { signal } : {}),
    ...(runId ? { runId } : {}),
  };
}

/**
 * With `onFailure: "keep"` (#3658) no onFailure drops the new table, so a
 * step that fails says what a person does instead: a refusal or a failed
 * verification would otherwise fail every run after it the same way.
 */
async function noting<T>(args: ClickHouseRebuildArgs, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (args.keepOnFailure && (err instanceof RebuildRefusal || err instanceof RebuildVerificationError)) {
      err.message +=
        ` This rebuild keeps its new table on failure (onFailure: "keep"), so nothing drops it: ` +
        `drop ${args.table}__chant_new and ${args.table}__chant_dual by hand to start again from a new table.`;
    }
    throw err;
  }
}

export interface RebuildPlanResult {
  state: "rebuild" | "swapped" | "done";
  table: string;
  /** The plan's digest, before the verification; present while there is a rebuild to run. */
  planDigest?: string;
  /** Each classified change, as `<rule> <field>: <before> -> <after>`. */
  changes: string[];
  summary: string;
}

/** Plan: classify the table's change against the server and say how far the rebuild has got. */
export async function clickhouseRebuildPlan(args: ClickHouseRebuildArgs, signal?: AbortSignal, deps: ClickHouseRebuildDeps = {}): Promise<RebuildPlanResult> {
  return noting(args, () => plan(args, signal, deps));
}

async function plan(args: ClickHouseRebuildArgs, signal: AbortSignal | undefined, deps: ClickHouseRebuildDeps): Promise<RebuildPlanResult> {
  const run = await rebuildRun(args, signal, deps);
  const o = await observeRebuild(run.target, run.declared, run.marker);
  const changes = o.changes.map((c) => `${c.rule} ${c.field}${c.before !== undefined || c.after !== undefined ? `: ${c.before ?? "none"} -> ${c.after ?? "none"}` : ""}`);
  const rebuilds = o.changes.filter((c) => c.class === "rebuild").map((c) => `${c.rule} ${CLASSIFIER_RULES[c.rule].title}`);
  const summary =
    o.state === "rebuild"
      ? `${o.names.key} needs a rebuild (${rebuilds.join("; ")}); ${o.copied.length} column(s) copied${o.newTable ? ", new table already made" : ""}`
      : o.state === "swapped"
        ? `${o.names.key} has been swapped; the old table is kept as ${o.names.database}.${o.names.oldName}`
        : `${o.names.key} holds its declaration; nothing to rebuild`;
  run.log(`-- ${summary}`);
  for (const c of changes) run.log(`--   ${c}`);
  return { state: o.state, table: o.names.key, ...(o.state === "rebuild" ? { planDigest: rebuildPlanDigest(o, run.dualWrite) } : {}), changes, summary };
}

export async function clickhouseRebuildCreate(args: ClickHouseRebuildArgs, signal?: AbortSignal, deps: ClickHouseRebuildDeps = {}): Promise<CreateResult> {
  return noting(args, async () => createNewTable(await rebuildRun(args, signal, deps)));
}

export async function clickhouseRebuildDualWrite(args: ClickHouseRebuildArgs, signal?: AbortSignal, deps: ClickHouseRebuildDeps = {}): Promise<DualWriteResult> {
  return noting(args, async () => startDualWrite(await rebuildRun(args, signal, deps)));
}

export async function clickhouseRebuildBackfill(args: ClickHouseRebuildArgs, signal?: AbortSignal, deps: ClickHouseRebuildDeps = {}): Promise<BackfillResult> {
  return noting(args, async () => backfill(await rebuildRun(args, signal, deps), deps.backfill));
}

export async function clickhouseRebuildVerify(args: ClickHouseRebuildArgs, signal?: AbortSignal, deps: ClickHouseRebuildDeps = {}): Promise<VerifyResult> {
  return noting(args, async () => verifyRebuild(await rebuildRun(args, signal, deps)));
}

export async function clickhouseRebuildSwap(args: ClickHouseRebuildArgs, signal?: AbortSignal, deps: ClickHouseRebuildDeps = {}): Promise<SwapResult> {
  return noting(args, async () => swapTables(await rebuildRun(args, signal, deps)));
}

export async function clickhouseRebuildRetain(args: ClickHouseRebuildArgs, signal?: AbortSignal, deps: ClickHouseRebuildDeps = {}): Promise<RetainResult> {
  return retainPlan(await rebuildRun(args, signal, deps));
}

export async function clickhouseRebuildDrop(args: ClickHouseRebuildArgs, signal?: AbortSignal, deps: ClickHouseRebuildDeps = {}): Promise<DropResult> {
  return dropOldTable(await rebuildRun(args, signal, deps));
}

/** onFailure: drop the new table and the dual-write view. */
export async function clickhouseRebuildCompensate(args: ClickHouseRebuildArgs, signal?: AbortSignal, deps: ClickHouseRebuildDeps = {}): Promise<CompensateResult> {
  return compensate(await rebuildRun(args, signal, deps));
}
