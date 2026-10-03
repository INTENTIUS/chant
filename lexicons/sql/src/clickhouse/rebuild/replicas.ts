/**
 * A replica of a Replicated database that is down (#3270): what each step of
 * the rebuild does about it.
 *
 * DDL (create, dual-write view, EXCHANGE, the views' DETACH and ATTACH, the
 * drops, the receipts table) goes through the database's log in Keeper. The
 * replica the run talks to executes it, and the others take it from the log;
 * one that is down runs it in order when it comes back. So DDL proceeds on
 * the live replicas: every statement carries
 * `distributed_ddl_output_mode = throw_only_active`, which "doesn't wait for
 * inactive replicas of the Replicated database" and still throws when a live
 * one fails the statement
 * (https://clickhouse.com/docs/reference/settings/session-settings/distributed-ddl).
 * With the default `throw` the statement would wait the whole
 * `distributed_ddl_task_timeout` (180s) for the down replica and then fail,
 * after the live replicas had already run it. A replica counts as inactive
 * once its Keeper session has expired (the client's `session_timeout_ms`,
 * 30s by default), so a statement right after a replica goes down waits that
 * long and then goes on. `KILL QUERY ON CLUSTER` takes the same setting and
 * behaves the same way.
 *
 * Reading rows is different. A part written on a replica that went down
 * before the others fetched it is on that replica alone, and the rows in it
 * cannot be read anywhere else. A backfill that went on without them would
 * copy the table less those rows, the verification would compare two tables
 * that both lack them and pass, and the swap would lose them. So before a
 * step reads rows it waits, for a bounded time, until this replica has
 * fetched everything the others wrote (`SYSTEM SYNC REPLICA ... LIGHTWEIGHT`,
 * https://clickhouse.com/docs/sql-reference/statements/system#sync-replica).
 * When the down replica holds nothing this one lacks, which is the usual case,
 * the wait returns at once and the step goes on. Otherwise the step stops
 * with a {@link ReplicaFetchError} naming the replica and its parts.
 */

import { clickhouseQuery, ClickHouseQueryError, type ClickHouseEndpoint } from "../http";
import { qualifiedIdent, sqlString } from "../apply/statements";

/** Settings every DDL statement of the rebuild carries: go on without the replicas that are down. Ignored in an Atomic database. */
export const DDL_SETTINGS: Readonly<Record<string, string>> = { distributed_ddl_output_mode: "throw_only_active" };

/** How long a step waits for this replica to fetch what the others wrote, by default. */
export const DEFAULT_REPLICA_TIMEOUT_MS = 120_000;

/**
 * One `SYSTEM SYNC REPLICA` waits at most this long (its `receive_timeout`),
 * and the wait is repeated until the deadline. It keeps each HTTP request
 * well inside the client's own five-minute response timeout, and puts a log
 * line between them.
 */
const SYNC_SLICE_S = 60;

/** A part this replica still has to fetch, and the replica it is to fetch it from. */
export interface MissingPart {
  part: string;
  /** The replica that wrote it, as `system.replication_queue` names it. */
  source: string;
  /** Whether Keeper still lists that replica as active (it does for a while after it went down, until its session expires). */
  sourceActive: boolean;
  /** The last fetch error, first line, if any. */
  lastError?: string;
}

/** A step stopped because this replica could not fetch parts that only another replica has. */
export class ReplicaFetchError extends Error {
  constructor(
    /** `db.t`. */
    readonly table: string,
    /** The replica the run talks to. */
    readonly replica: string,
    readonly missing: MissingPart[],
    readonly waitedMs: number,
  ) {
    const sources = [...new Set(missing.map((m) => m.source))];
    const shown = missing
      .slice(0, 10)
      .map((m) => `${m.part} from ${m.source}${m.sourceActive ? "" : " (inactive)"}${m.lastError ? ` (last fetch error: ${m.lastError})` : ""}`)
      .join(", ");
    super(
      `${table}: waited ${Math.round(waitedMs / 1000)}s for replica ${replica} to fetch what the other replicas wrote, and ${missing.length} part(s) are still to fetch: ${shown}${missing.length > 10 ? ", ..." : ""}. ` +
        `Those rows are on ${sources.join(", ")} alone, so the step stops rather than read the table without them; nothing has been swapped. ` +
        `Bring ${sources.join(", ")} back (it rejoins through Keeper and this replica fetches the parts), then run again. ` +
        `replicaTimeout sets how long a step waits.`,
    );
    this.name = "ReplicaFetchError";
  }
}

const isTimeout = (err: unknown) => err instanceof ClickHouseQueryError && /TIMEOUT_EXCEEDED|command timed out/.test(err.serverMessage);

/**
 * Wait until this replica has fetched every part the others have written to
 * `database.table`, for at most `timeoutMs`; then throw a
 * {@link ReplicaFetchError} naming what it still lacks and where that is.
 */
export async function syncReplicaWithin(
  endpoint: ClickHouseEndpoint,
  database: string,
  table: string,
  opts: { timeoutMs?: number; log?: (line: string) => void; signal?: AbortSignal } = {},
): Promise<void> {
  const started = Date.now();
  const deadline = started + (opts.timeoutMs ?? DEFAULT_REPLICA_TIMEOUT_MS);
  const sql = `SYSTEM SYNC REPLICA ${qualifiedIdent(database, table)} LIGHTWEIGHT`;
  opts.log?.(sql);
  for (;;) {
    opts.signal?.throwIfAborted();
    const slice = Math.max(1, Math.min(SYNC_SLICE_S, Math.ceil((deadline - Date.now()) / 1000)));
    try {
      await clickhouseQuery(endpoint, sql, { settings: { receive_timeout: String(slice) }, ...(opts.signal ? { signal: opts.signal } : {}) });
      return;
    } catch (err) {
      if (!isTimeout(err)) throw err;
    }
    const { replica, missing } = await missingParts(endpoint, database, table);
    // Fetched between the timeout and the look: nothing is left to wait for.
    if (missing.length === 0) return;
    if (Date.now() >= deadline) throw new ReplicaFetchError(`${database}.${table}`, replica, missing, Date.now() - started);
    opts.log?.(`-- ${database}.${table}: replica ${replica} is still to fetch ${missing.length} part(s) from ${[...new Set(missing.map((m) => m.source))].join(", ")}; waiting`);
  }
}

/** The parts this replica's queue is still to fetch for `database.table`, with where from. */
export async function missingParts(endpoint: ClickHouseEndpoint, database: string, table: string): Promise<{ replica: string; missing: MissingPart[] }> {
  const where = `database = ${sqlString(database)} AND table = ${sqlString(table)}`;
  const [replicas] = await clickhouseQuery<{ replica_name: string; replica_is_active: Record<string, number> }>(
    endpoint,
    `SELECT replica_name, replica_is_active FROM system.replicas WHERE ${where}`,
  );
  // The entries LIGHTWEIGHT waits for.
  const queue = await clickhouseQuery<{ new_part_name: string; source_replica: string; last_exception: string }>(
    endpoint,
    `SELECT new_part_name, source_replica, last_exception FROM system.replication_queue WHERE ${where} ` +
      `AND type IN ('GET_PART', 'ATTACH_PART', 'DROP_RANGE', 'REPLACE_RANGE', 'DROP_PART') ORDER BY new_part_name`,
  );
  const active = replicas?.replica_is_active ?? {};
  return {
    replica: replicas?.replica_name ?? "this replica",
    missing: queue.map((e) => {
      const lastError = e.last_exception.trim().split("\n")[0];
      return {
        part: e.new_part_name,
        source: e.source_replica || "another replica",
        sourceActive: Number(active[e.source_replica] ?? 0) === 1,
        ...(lastError ? { lastError } : {}),
      };
    }),
  };
}
