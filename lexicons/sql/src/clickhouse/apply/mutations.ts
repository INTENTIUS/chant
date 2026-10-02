/**
 * Waiting on a background rewrite (#3208).
 *
 * A column type change or a TTL change returns as soon as the server has
 * recorded it; the rewrite of existing parts runs afterwards as a mutation,
 * listed in `system.mutations` until it is done. An apply that reported
 * APPLIED at that point would claim a table had converged while its parts
 * were still being rewritten, so the applier waits for every unfinished
 * mutation on the table, and reports the ids when it stops waiting.
 */

import { clickhouseQuery, type ClickHouseEndpoint } from "../http";
import { sqlString } from "./statements";

export interface PendingMutation {
  mutation_id: string;
  command: string;
  latest_fail_reason: string;
}

/** A mutation that did not finish in time. The ids are what `system.mutations` and `KILL MUTATION` name. */
export class MutationTimeoutError extends Error {
  constructor(
    readonly table: string,
    readonly mutationIds: string[],
    readonly timeoutMs: number,
  ) {
    super(
      `${table}: mutation ${mutationIds.join(", ")} was still running after ${Math.round(timeoutMs / 1000)}s. ` +
        `It goes on in the background; follow it in system.mutations, or stop it with KILL MUTATION WHERE mutation_id = '${mutationIds[0]}'.`,
    );
    this.name = "MutationTimeoutError";
  }
}

/** A mutation the server keeps failing. It is retried forever, so waiting longer does not help. */
export class MutationFailedError extends Error {
  constructor(
    readonly table: string,
    readonly mutationId: string,
    readonly reason: string,
  ) {
    super(
      `${table}: mutation ${mutationId} is failing: ${reason.split("\n")[0]}. ` +
        `The server retries it until it is killed: KILL MUTATION WHERE mutation_id = '${mutationId}'.`,
    );
    this.name = "MutationFailedError";
  }
}

/** The table's mutations that are not done. */
export async function pendingMutations(endpoint: ClickHouseEndpoint, database: string, table: string): Promise<PendingMutation[]> {
  return clickhouseQuery<PendingMutation>(
    endpoint,
    `SELECT mutation_id, command, latest_fail_reason FROM system.mutations ` +
      `WHERE database = ${sqlString(database)} AND table = ${sqlString(table)} AND NOT is_done ORDER BY create_time`,
  );
}

export interface WaitOptions {
  /** How long to wait in all. Default: ten minutes. */
  timeoutMs?: number;
  /** First poll interval; it doubles up to two seconds. Default: 100ms. */
  intervalMs?: number;
  signal?: AbortSignal;
}

/**
 * Wait until the table has no unfinished mutation. Returns the ids waited on.
 * Throws {@link MutationFailedError} as soon as one reports a failure, and
 * {@link MutationTimeoutError} naming the ids still running at the deadline.
 */
export async function waitForMutations(endpoint: ClickHouseEndpoint, database: string, table: string, opts: WaitOptions = {}): Promise<string[]> {
  const timeoutMs = opts.timeoutMs ?? 600_000;
  const deadline = Date.now() + timeoutMs;
  let interval = opts.intervalMs ?? 100;
  const seen = new Set<string>();
  const name = `${database}.${table}`;
  for (;;) {
    opts.signal?.throwIfAborted();
    const pending = await pendingMutations(endpoint, database, table);
    for (const m of pending) seen.add(m.mutation_id);
    if (pending.length === 0) return [...seen];
    const failing = pending.find((m) => m.latest_fail_reason);
    if (failing) throw new MutationFailedError(name, failing.mutation_id, failing.latest_fail_reason);
    if (Date.now() >= deadline) throw new MutationTimeoutError(name, pending.map((m) => m.mutation_id), timeoutMs);
    await new Promise((r) => setTimeout(r, Math.min(interval, Math.max(0, deadline - Date.now()))));
    interval = Math.min(interval * 2, 2_000);
  }
}
