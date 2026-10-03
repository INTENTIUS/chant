/**
 * The expand-and-contract migration's activities (#3281), one per step of
 * `PostgresMigrationOp` (`../../postgres/migrate/op.ts`). Each takes the same
 * arguments, reads the build's declaration of the table and binds the
 * environment's server the way the applier does (`./postgres-apply.ts`),
 * opens one connection with node-postgres (loaded only now), runs its step
 * (`../../postgres/migrate/`), which re-reads the server, and closes the
 * connection.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { ChantConfig } from "@intentius/chant/config";
import { currentOpRun, parseDuration } from "@intentius/chant/op";
import { resolveOwnershipMarker } from "../../core/apply";
import { resolveBoundTarget } from "../../postgres/live/bind";
import { connectPostgres, type PostgresClient, type PostgresEndpoint } from "../../postgres/live/client";
import { DEFAULT_POSTGRES_APPLY_TIMEOUTS, declaredObjects } from "../../postgres/apply/apply";
import { PG_CLASSIFIER_RULES } from "../../postgres/plan/rules";
import { declaredTable, migrationPlanDigest, observeMigration } from "../../postgres/migrate/observe";
import { backfill, verifyMigration, type BackfillDeps, type BackfillResult, type VerifyResult } from "../../postgres/migrate/backfill";
import {
  carryOver,
  compensate,
  contract,
  expand,
  retainPlan,
  startDualWrite,
  switchColumns,
  type CarryResult,
  type CompensateResult,
  type ContractResult,
  type DualWriteResult,
  type ExpandResult,
  type MigrationRun,
  type RetainResult,
  type SwitchResult,
} from "../../postgres/migrate/steps";
import { DEFAULT_REPLICATION_LAG } from "../../postgres/migrate/replication";
import type { PostgresMigrationArgs } from "../../postgres/migrate/op";
import { buildMajor } from "./postgres-apply";

export type { PostgresMigrationArgs } from "../../postgres/migrate/op";

/** What a test (or an embedding caller) may inject instead of the project's config, the process env and node-postgres. */
export interface PostgresMigrationDeps {
  config?: Pick<ChantConfig, "sql" | "ownership">;
  env?: Record<string, string | undefined>;
  log?: (line: string) => void;
  connect?: (endpoint: PostgresEndpoint) => Promise<PostgresClient>;
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

/** Bind the server, connect and read the declaration, run `body` with it, then close the connection. */
async function withRun<T>(args: PostgresMigrationArgs, signal: AbortSignal | undefined, deps: PostgresMigrationDeps, body: (run: MigrationRun) => Promise<T>): Promise<T> {
  const cwd = args.cwd ?? process.cwd();
  const config = deps.config ?? (await loadConfig(cwd));
  const marker = resolveOwnershipMarker(args, config, "PostgresMigrationOp");
  const target = await resolveBoundTarget({ ...(args.environment !== undefined ? { environment: args.environment } : {}), config: config ?? {}, ...(deps.env ? { env: deps.env } : {}) });
  const json = readFileSync(resolve(cwd, args.buildPath), "utf8");
  const objects = declaredObjects(json, target.defaultSchema);
  const declared = declaredTable(objects, args.table);
  const major = buildMajor(json) ?? config?.sql?.postgresMajor;
  const lag = args.replicationLag;
  const client = await (deps.connect ?? ((e) => connectPostgres(e, { applicationName: "chant migration" })))(target.endpoint);
  const runId = currentOpRun()?.runId;
  try {
    return await body({
      client,
      target,
      declared,
      objects,
      column: args.column,
      ...(args.using !== undefined ? { using: args.using } : {}),
      ...(marker ? { marker } : {}),
      ...(major !== undefined ? { major } : {}),
      batchSize: args.batchSize ?? 1000,
      retainMs: parseDuration(args.retain ?? "7d"),
      replicationLag:
        lag === false
          ? false
          : {
              maxLagMs: lag?.max !== undefined ? parseDuration(lag.max) : DEFAULT_REPLICATION_LAG.maxLagMs,
              waitMs: lag?.wait !== undefined ? parseDuration(lag.wait) : DEFAULT_REPLICATION_LAG.waitMs,
            },
      lockTimeoutMs: args.lockTimeoutMs ?? target.timeouts?.lockTimeoutMs ?? DEFAULT_POSTGRES_APPLY_TIMEOUTS.lockTimeoutMs,
      statementTimeoutMs: args.statementTimeoutMs ?? target.timeouts?.statementTimeoutMs ?? DEFAULT_POSTGRES_APPLY_TIMEOUTS.statementTimeoutMs,
      log: deps.log ?? ((line: string) => console.log(line)),
      ...(signal ? { signal } : {}),
      ...(runId ? { runId } : {}),
    });
  } finally {
    await client.end();
  }
}

export interface MigrationPlanResult {
  state: "migrate" | "switched" | "done";
  /** `schema.table.column`. */
  migration: string;
  change: "rename" | "type";
  /** The plan's digest, before the verification; present while there is a migration to run. */
  planDigest?: string;
  /** Each classified change, as `<rule> <field>: <before> -> <after>`. */
  changes: string[];
  summary: string;
}

/** Plan: classify the column's change against the server and say how far the migration has got. */
export async function postgresMigrationPlan(args: PostgresMigrationArgs, signal?: AbortSignal, deps: PostgresMigrationDeps = {}): Promise<MigrationPlanResult> {
  return withRun(args, signal, deps, async (run) => {
    const o = await observeMigration({
      client: run.client,
      target: run.target,
      declared: run.declared,
      ...(run.objects ? { objects: run.objects } : {}),
      column: run.column,
      ...(run.marker ? { marker: run.marker } : {}),
      ...(run.using !== undefined ? { using: run.using } : {}),
      ...(run.major !== undefined ? { major: run.major } : {}),
    });
    const n = o.names;
    const changes = o.changes.map((c) => `${c.rule} ${c.field}${c.before !== undefined || c.after !== undefined ? `: ${c.before ?? "none"} -> ${c.after ?? "none"}` : ""}`);
    const made = o.changes.filter((c) => c.rule === "SQLPG205" || c.rule === "SQLPG207" || c.rule === "SQLPG208").map((c) => `${c.rule} ${PG_CLASSIFIER_RULES[c.rule].title}`);
    const summary =
      o.state === "migrate"
        ? `${n.key} needs expand and contract (${made.join("; ")}): ${n.change === "rename" ? `${n.source} renamed to ${n.column}` : `${n.column} as ${o.column.type}, computed as ${o.expression}`}, batched by ${o.batchKey}${o.newColumn ? `; ${n.newColumn} already added` : ""}`
        : o.state === "switched"
          ? `${n.key} has been switched; the old column is kept as ${n.oldColumn}`
          : `${n.key} holds its declaration; nothing to migrate`;
    run.log(`-- ${summary}`);
    for (const c of changes) run.log(`--   ${c}`);
    return { state: o.state, migration: n.key, change: n.change, ...(o.state === "migrate" ? { planDigest: migrationPlanDigest(o) } : {}), changes, summary };
  });
}

export async function postgresMigrationExpand(args: PostgresMigrationArgs, signal?: AbortSignal, deps: PostgresMigrationDeps = {}): Promise<ExpandResult> {
  return withRun(args, signal, deps, expand);
}

export async function postgresMigrationDualWrite(args: PostgresMigrationArgs, signal?: AbortSignal, deps: PostgresMigrationDeps = {}): Promise<DualWriteResult> {
  return withRun(args, signal, deps, startDualWrite);
}

export async function postgresMigrationBackfill(args: PostgresMigrationArgs, signal?: AbortSignal, deps: PostgresMigrationDeps = {}): Promise<BackfillResult> {
  return withRun(args, signal, deps, (run) => backfill(run, deps.backfill));
}

/** Carry over: the indexes and constraints on the old column, made again on the new one. */
export async function postgresMigrationCarry(args: PostgresMigrationArgs, signal?: AbortSignal, deps: PostgresMigrationDeps = {}): Promise<CarryResult> {
  return withRun(args, signal, deps, carryOver);
}

export async function postgresMigrationVerify(args: PostgresMigrationArgs, signal?: AbortSignal, deps: PostgresMigrationDeps = {}): Promise<VerifyResult> {
  return withRun(args, signal, deps, verifyMigration);
}

export async function postgresMigrationSwitch(args: PostgresMigrationArgs, signal?: AbortSignal, deps: PostgresMigrationDeps = {}): Promise<SwitchResult> {
  return withRun(args, signal, deps, switchColumns);
}

export async function postgresMigrationRetain(args: PostgresMigrationArgs, signal?: AbortSignal, deps: PostgresMigrationDeps = {}): Promise<RetainResult> {
  return withRun(args, signal, deps, retainPlan);
}

export async function postgresMigrationContract(args: PostgresMigrationArgs, signal?: AbortSignal, deps: PostgresMigrationDeps = {}): Promise<ContractResult> {
  return withRun(args, signal, deps, contract);
}

/** onFailure: drop what the expand added. */
export async function postgresMigrationCompensate(args: PostgresMigrationArgs, signal?: AbortSignal, deps: PostgresMigrationDeps = {}): Promise<CompensateResult> {
  return withRun(args, signal, deps, compensate);
}
