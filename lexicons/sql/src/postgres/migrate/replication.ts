/**
 * Replication around an expand-and-contract migration (#3281): the backfill
 * pauses while a replica is behind, and a table that logical replication
 * publishes is refused.
 *
 * ## Lag
 *
 * A backfill writes every row of the table once more, and each batch's WAL
 * goes to every standby and every logical subscriber. Before each batch the
 * backfill reads `pg_stat_replication` on the primary
 * (https://www.postgresql.org/docs/18/monitoring-stats.html#MONITORING-PG-STAT-REPLICATION-VIEW),
 * one row per WAL sender, and waits while any `replay_lag` is above the
 * bound, up to a deadline, then stops naming the replica. `replay_lag` is
 * NULL once a standby has caught up and nothing new is being sent, which is
 * no lag. No rows means no replicas, and the check passes at once: a single
 * server, or a managed one whose replicas are not WAL senders (Aurora's
 * share storage), skips cleanly.
 *
 * A role that is neither superuser nor a member of `pg_monitor` sees the
 * rows with every column but the process's own NULL, so the lag cannot be
 * read; that stops the backfill with the grant to make, rather than go on
 * blind. `replicationLag: false` on the Op turns the check off.
 *
 * ## Publications
 *
 * A logical replication subscriber applies each published row change by
 * column name, and its own table must have every column the publisher
 * sends ("Logical Replication", Restrictions and Column Lists,
 * https://www.postgresql.org/docs/18/logical-replication-col-lists.html).
 * The expand adds a column, so a publication that sends the whole table
 * would fail the subscriber's apply at the first backfilled row, and a
 * rename or a type change would need the same change on the subscriber at
 * the same moment as the switch. The Plan phase therefore refuses a table a
 * publication sends the migrated column of, naming each publication. A
 * publication with a column list (15 and later) that leaves the column out
 * sends neither it nor the new one, and does not stop the migration.
 */

import type { PostgresClient } from "../live/client";

export interface ReplicationLagBound {
  /** The most a replica may be behind before a batch waits, in ms. */
  maxLagMs: number;
  /** How long one wait may last before the backfill stops, in ms. */
  waitMs: number;
}

export const DEFAULT_REPLICATION_LAG: ReplicationLagBound = { maxLagMs: 10_000, waitMs: 30 * 60_000 };

/** A replica that stayed behind past the wait, or whose lag this role cannot read. */
export class ReplicationLagError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReplicationLagError";
  }
}

export interface ReplicaLag {
  /** `application_name`, else the client address, else the process id. */
  name: string;
  /** Replay lag in ms; undefined when the role cannot read it. */
  lagMs?: number;
}

/** The WAL senders on this server and how far behind each replica's replay is. */
export async function replicaLags(client: Pick<PostgresClient, "query">): Promise<ReplicaLag[]> {
  const rows = await client.query<{ name: string; state: string | null; lag_ms: string | number | null }>(
    `SELECT COALESCE(NULLIF(application_name, ''), client_addr::text, pid::text) AS name, state,
            (EXTRACT(EPOCH FROM replay_lag) * 1000)::bigint AS lag_ms
     FROM pg_catalog.pg_stat_replication`,
  );
  return rows.map((r) => ({ name: r.name, ...(r.state !== null ? { lagMs: r.lag_ms === null ? 0 : Number(r.lag_ms) } : {}) }));
}

/**
 * Wait until every replica is within the bound. Returns how long it waited,
 * in ms (0 when no replica was behind, or there are none).
 */
export async function waitForReplicas(
  client: Pick<PostgresClient, "query">,
  bound: ReplicationLagBound,
  opts: { log?: (line: string) => void; signal?: AbortSignal; sleep?: (ms: number, signal?: AbortSignal) => Promise<void>; now?: () => number } = {},
): Promise<number> {
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? sleepFor;
  const started = now();
  for (;;) {
    opts.signal?.throwIfAborted();
    const lags = await replicaLags(client);
    const unreadable = lags.filter((l) => l.lagMs === undefined);
    if (unreadable.length > 0) {
      throw new ReplicationLagError(
        `pg_stat_replication lists ${unreadable.length} replica(s) (${unreadable.map((l) => l.name).join(", ")}) whose lag this role cannot read. ` +
          `Grant it pg_monitor (GRANT pg_monitor TO <role>) so the backfill can pause while a replica is behind, or set replicationLag: false on the Op to run without the check.`,
      );
    }
    const behind = lags.filter((l) => l.lagMs! > bound.maxLagMs);
    if (behind.length === 0) return now() - started;
    const waited = now() - started;
    const shown = behind.map((l) => `${l.name} ${Math.round(l.lagMs! / 1000)}s`).join(", ");
    if (waited >= bound.waitMs) {
      throw new ReplicationLagError(
        `waited ${Math.round(waited / 1000)}s for replicas to come within ${Math.round(bound.maxLagMs / 1000)}s of the primary and they did not: ${shown} behind. ` +
          `The backfill stops here; its receipts keep the batches it filled, and the next run goes on from there.`,
      );
    }
    opts.log?.(`-- replicas behind (${shown}); pausing the backfill`);
    await sleep(Math.min(1_000, bound.waitMs - waited), opts.signal);
  }
}

/** One publication that sends the migrated column. */
export interface PublicationHit {
  name: string;
  /** Whether it sends every column (no column list). */
  allColumns: boolean;
}

/**
 * The publications that send `column` of `schema.table`. On 15 and later a
 * publication with a column list that leaves the column out is not one;
 * before 15 there are no column lists, and any publication of the table is.
 */
export async function publicationsOf(client: Pick<PostgresClient, "query">, schema: string, table: string, column: string, major: number): Promise<PublicationHit[]> {
  if (major >= 15) {
    const rows = await client.query<{ pubname: string; attnames: string[] | null; listed: boolean }>(
      `SELECT pt.pubname, pt.attnames,
              EXISTS (SELECT 1 FROM pg_catalog.pg_publication p JOIN pg_catalog.pg_publication_rel r ON r.prpubid = p.oid
                      WHERE p.pubname = pt.pubname AND r.prrelid = pg_catalog.to_regclass(pg_catalog.quote_ident($1) || '.' || pg_catalog.quote_ident($2)) AND r.prattrs IS NOT NULL) AS listed
       FROM pg_catalog.pg_publication_tables pt WHERE pt.schemaname = $1 AND pt.tablename = $2 ORDER BY pt.pubname`,
      [schema, table],
    );
    return rows.filter((r) => !r.listed || (r.attnames ?? []).includes(column)).map((r) => ({ name: r.pubname, allColumns: !r.listed }));
  }
  const rows = await client.query<{ pubname: string }>("SELECT pubname FROM pg_catalog.pg_publication_tables WHERE schemaname = $1 AND tablename = $2 ORDER BY pubname", [schema, table]);
  return rows.map((r) => ({ name: r.pubname, allColumns: true }));
}

function sleepFor(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(t);
        reject(signal.reason);
      },
      { once: true },
    );
  });
}
