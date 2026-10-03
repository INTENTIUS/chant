/**
 * The verification (#3198): row counts and checksums per partition, the old
 * table against the new one, before anyone is asked to approve the swap.
 *
 * Per partition of the old table: the number of rows and the sum of a
 * 64-bit hash of each row's copied columns, read in one grouped query on
 * each side. The old side casts each column to its type in the new table
 * first, so a column whose type the rebuild changes hashes the same when
 * its values survived the change. In materialized-view mode both sides are
 * limited to the rows before the cut-over, which are the backfill's; the
 * rows after it were written by the dual-write view and keep arriving.
 *
 * Any difference fails the run, naming the partitions; the run's onFailure
 * then drops the new table. On a match the result carries the digest the
 * swap gate binds: the rebuild's plan and the verification together, so an
 * approval is for this plan with these counts, and a changed count needs a
 * new approval.
 */

import { computePlanDigest } from "@intentius/chant/op";
import { clickhouseQuery } from "../http";
import { ident, sqlString } from "../apply/statements";
import { rebuildPlanSubject, RebuildRefusal, type RebuildObservation } from "./observe";
import { sourcePartitionExpression } from "./partitions";
import { cutoverOf, observe, syncReplica, utcLiteral, waitOn, type RebuildRun } from "./steps";

export interface PartitionCheck {
  partition: string;
  rows: number;
  checksum: string;
}

export interface VerifyResult {
  state: RebuildObservation["state"];
  /** The digest the swap gate binds: plan plus verification. Absent once the swap has run: there is nothing left for that gate to approve. */
  planDigest?: string;
  partitions: number;
  rows: number;
  /** One line for the run record and the gate. */
  summary: string;
  verification: PartitionCheck[];
}

/** A verification that found the tables different. */
export class RebuildVerificationError extends Error {
  constructor(
    readonly table: string,
    readonly mismatches: Array<{ partition: string; old?: PartitionCheck; new?: PartitionCheck }>,
  ) {
    const shown = mismatches
      .slice(0, 10)
      .map((m) => `${m.partition}: old ${m.old ? `${m.old.rows} rows, checksum ${m.old.checksum}` : "none"}, new ${m.new ? `${m.new.rows} rows, checksum ${m.new.checksum}` : "none"}`)
      .join("; ");
    super(
      `${table}: the new table does not match the old one in ${mismatches.length} partition(s): ${shown}${mismatches.length > 10 ? "; ..." : ""}. ` +
        `Nothing was swapped. In materialized-view mode a row written to the old table later than the cut-over delay, with a time before the cut-over, is the usual cause.`,
    );
    this.name = "RebuildVerificationError";
  }
}

export async function verifyRebuild(run: RebuildRun): Promise<VerifyResult> {
  const o = await observe(run);
  if (o.state !== "rebuild") return { state: o.state, partitions: 0, rows: 0, verification: [], summary: `nothing to verify: ${o.state}` };
  if (!o.newTable) throw new RebuildRefusal(`${o.names.key}: the new table is not there yet; the Create phase makes it`);
  const n = o.names;
  const cutover = cutoverOf(run, o);
  await waitOn(run, n.database, n.name);
  await waitOn(run, n.database, n.newName);
  // In a Replicated database: count what every replica wrote, not what this one has fetched so far.
  await syncReplica(run, o, n.database, n.name);
  await syncReplica(run, o, n.database, n.newName);

  const types = new Map(
    (
      await clickhouseQuery<{ name: string; type: string }>(
        run.target.endpoint,
        `SELECT name, type FROM system.columns WHERE database = ${sqlString(n.database)} AND table = ${sqlString(n.newName)}`,
      )
    ).map((c) => [c.name, c.type]),
  );
  const oldHash = `sum(cityHash64(toString(tuple(${o.copied.map((c) => `CAST(${ident(c.source)}, ${sqlString(types.get(c.name) ?? "String")})`).join(", ")}))))`;
  const newHash = `sum(cityHash64(toString(tuple(${o.copied.map((c) => ident(c.name)).join(", ")}))))`;
  const cut = run.dualWrite.mode === "materialized-view" ? o.copied.find((c) => c.name === (run.dualWrite as { cutoverColumn: string }).cutoverColumn) : undefined;
  const oldWhere = cut && cutover !== undefined ? ` WHERE ${ident(cut.source)} < ${utcLiteral(cutover)}` : "";
  const newWhere = cut && cutover !== undefined ? ` WHERE ${ident(cut.name)} < ${utcLiteral(cutover)}` : "";
  const fromOld = sourcePartitionExpression(o.live.partitionKey, o.newTable.partitionKey, o.copied);

  const read = async (sql: string) =>
    new Map(
      (await clickhouseQuery<{ p: string; rows: string | number; checksum: string }>(run.target.endpoint, sql)).map((r) => [
        r.p,
        { partition: r.p, rows: Number(r.rows), checksum: r.checksum },
      ]),
    );
  const before = await read(`SELECT _partition_id AS p, count() AS rows, toString(${oldHash}) AS checksum FROM ${n.table}${oldWhere} GROUP BY p`);
  const after = await read(`SELECT ${fromOld} AS p, count() AS rows, toString(${newHash}) AS checksum FROM ${n.newTable}${newWhere} GROUP BY p`);

  const mismatches: Array<{ partition: string; old?: PartitionCheck; new?: PartitionCheck }> = [];
  for (const p of [...new Set([...before.keys(), ...after.keys()])].sort()) {
    const a = before.get(p);
    const b = after.get(p);
    if (!a || !b || a.rows !== b.rows || a.checksum !== b.checksum) mismatches.push({ partition: p, ...(a ? { old: a } : {}), ...(b ? { new: b } : {}) });
  }
  if (mismatches.length > 0) throw new RebuildVerificationError(n.key, mismatches);

  const verification = [...before.values()].sort((x, y) => x.partition.localeCompare(y.partition));
  const rows = verification.reduce((s, v) => s + v.rows, 0);
  const range = cutover !== undefined ? ` before the cut-over at ${new Date(cutover).toISOString()}` : "";
  const summary = `${n.key}: ${verification.length} partition(s), ${rows} row(s)${range}, counts and checksums equal in the old and new tables`;
  run.log(`-- ${summary}`);
  return {
    state: o.state,
    planDigest: computePlanDigest("clickhouse-rebuild", {
      plan: rebuildPlanSubject(o, run.dualWrite),
      cutover: cutover === undefined ? null : new Date(cutover).toISOString(),
      verification,
    }),
    partitions: verification.length,
    rows,
    summary,
    verification,
  };
}
