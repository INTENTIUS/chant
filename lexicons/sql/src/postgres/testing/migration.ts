/**
 * Running `PostgresMigrationOp` in a live test (#3281, #3322): the Op's
 * activities with the test's config and server, core's local executor, and
 * an in-memory gate ledger a test approves on.
 */

import { memoryGateLedgerPort, runOpLocally, loadProfiles, type ActivityFn, type GateLedgerPort, type OpConfig, type OpRunResult } from "@intentius/chant/op";
import * as migrationActivities from "../../op/activities/postgres-migration";
import type { PostgresMigrationDeps } from "../../op/activities/postgres-migration";
import { PostgresMigrationOp, type PostgresMigrationOpConfig } from "../migrate/op";

/** The migration activities, each called with `deps()`, as the local executor resolves them. */
export function migrationActivityMap(deps: () => PostgresMigrationDeps): Map<string, ActivityFn> {
  const map = new Map<string, ActivityFn>();
  for (const [name, fn] of Object.entries(migrationActivities)) {
    if (typeof fn !== "function" || !name.startsWith("postgresMigration")) continue;
    map.set(name, ((args: Record<string, unknown>, signal?: AbortSignal) => (fn as (a: unknown, s?: AbortSignal, d?: unknown) => Promise<unknown>)(args, signal, deps())) as ActivityFn);
  }
  return map;
}

/** One run of the Op through core's local executor, as far as its next gate. */
export async function runMigrationOp(config: PostgresMigrationOpConfig, gates: GateLedgerPort, deps: () => PostgresMigrationDeps): Promise<OpRunResult> {
  const { op } = PostgresMigrationOp(config);
  const props = (op as unknown as { props: OpConfig }).props;
  return runOpLocally(props, migrationActivityMap(deps), await loadProfiles(), undefined, { gates, now: new Date().toISOString() });
}

/** An in-memory gate ledger a person approves on: each approval answers the gate the last run stopped at, for the plan it recorded. */
export class ApprovingLedger {
  private pending: unknown[] = [];
  private resolutions: unknown[] = [];
  port = memoryGateLedgerPort();

  approveLast(): void {
    const last = this.port.appended.at(-1)!;
    this.pending.push(...this.port.appended);
    this.resolutions.push({
      version: 1,
      kind: "resolution",
      op: last.op,
      gate: last.gate,
      resolvedBy: "e2e",
      timestamp: new Date(Date.parse(last.timestamp) + 1000).toISOString(),
      ...(last.planDigest ? { planDigest: last.planDigest } : {}),
    });
    this.port = memoryGateLedgerPort({ pending: this.pending as never, resolutions: this.resolutions as never });
  }
}

/** An outcome attribute a run recorded. */
export const runOutcome = (r: OpRunResult, name: string): unknown => r.records.flatMap((x) => x.outcomes ?? []).find((o) => o.name === name)?.value;
