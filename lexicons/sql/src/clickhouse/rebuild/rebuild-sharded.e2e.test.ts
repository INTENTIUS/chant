/**
 * The rebuild migration on a cluster of two shards (#3663), against a
 * scratch cluster of the pinned image: shard 1 of two replicas, shard 2 of
 * one server, Keeper, and a cluster `chant` over all three. The profile
 * names shard 1's first replica with topology `cluster:chant`.
 *
 * Each shard holds its own rows of `shop.events`, with a `Distributed`
 * table over them. An `ORDER BY` change runs as a `ClickHouseRebuildOp`
 * under an outer approval, keeping its new table on failure:
 *
 * - the first run copies shard 1's partitions and one of shard 2's, then
 *   fails: each (shard, partition) copied has its own receipt;
 * - the rerun skips those, copies the rest of shard 2, verifies every row of
 *   both shards, and swaps: every shard's rows are in its live table, on
 *   every replica, with the new sorting key.
 *
 * Runs the Op through core's local executor. Needs Docker; skips cleanly
 * without it.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { normalizeApply } from "@intentius/chant/apply";
import { memoryGateLedgerPort, runOpLocally, loadProfiles, OpRunFailure, type ActivityFn, type OpConfig, type OpRunResult } from "@intentius/chant/op";
import { dockerAvailable, startScratchCluster, type ScratchCluster } from "../container";
import { clickhouseQuery, type ClickHouseEndpoint } from "../http";
import { clickhouseImage } from "../../spec/pin";
import { clickhouseApply, toApplyResult } from "../../op/activities/clickhouse-apply";
import * as rebuildActivities from "../../op/activities/clickhouse-rebuild";
import type { ClickHouseRebuildDeps } from "../../op/activities/clickhouse-rebuild";
import { ClickHouseRebuildOp, type ClickHouseRebuildOpConfig } from "./op";

const enabled = await dockerAvailable();
let cluster: ScratchCluster | undefined;
const dir = mkdtempSync(join(tmpdir(), "chant-sql-rebuild-sharded-"));

beforeAll(async () => {
  if (!enabled) return;
  cluster = await startScratchCluster(clickhouseImage(), { shards: [2, 1], cluster: "chant", namePrefix: "chant-sql-rebuild-shards" });
}, 600_000);

afterAll(async () => {
  await cluster?.stop();
  rmSync(dir, { recursive: true, force: true });
});

const MARKER = { stack: "e2e", env: "test" };
const config = () => ({ ownership: MARKER, sql: { profiles: { e2e: { url: cluster!.replicas[0]!.url, topology: "cluster:chant" } } } });
const deps = (extra: Partial<ClickHouseRebuildDeps> = {}): ClickHouseRebuildDeps => ({ config: config(), env: {}, log: () => undefined, ...extra });
const q = <T = Record<string, unknown>>(endpoint: ClickHouseEndpoint, sql: string) => clickhouseQuery<T>(endpoint, sql);
const count = async (endpoint: ClickHouseEndpoint, table: string) => Number((await q<{ n: string }>(endpoint, `SELECT count() AS n FROM ${table}`))[0]!.n);
/** The servers of a shard, by its macro. */
const servers = (shard: string) => cluster!.layout.flatMap((l, i) => (l.shard === shard ? [cluster!.replicas[i]!] : []));

const eventsDdl = (orderBy: string) => `CREATE TABLE shop.events
(
  ts DateTime,
  user_id UInt64,
  kind LowCardinality(String)
)
ENGINE = MergeTree
PARTITION BY toDate(ts)
ORDER BY ${orderBy}`;
const DISTRIBUTED = "CREATE TABLE shop.events_all (ts DateTime, user_id UInt64, kind LowCardinality(String)) ENGINE = Distributed(chant, shop, events, user_id)";

function writeBuild(file: string, orderBy: string): string {
  const objects = [
    { export: "shop", type: "ClickHouse::Database", ddl: "CREATE DATABASE shop", dependsOn: [] },
    { export: "events", type: "ClickHouse::Table", ddl: eventsDdl(orderBy), dependsOn: ["shop"] },
    { export: "eventsAll", type: "ClickHouse::Table", ddl: DISTRIBUTED, dependsOn: ["events"] },
  ];
  writeFileSync(join(dir, file), JSON.stringify({ dialect: "clickhouse", applyOrder: objects.map((o) => o.export), objects }));
  return file;
}

const opConfig = (): ClickHouseRebuildOpConfig => ({
  name: "rebuild-events",
  env: "e2e",
  table: "shop.events",
  dualWrite: { mode: "materialized-view", cutoverColumn: "ts", cutoverDelay: "2s" },
  build: false,
  path: dir,
  output: "events-v2.json",
  stack: MARKER.stack,
  ownershipEnv: MARKER.env,
  gates: "outer",
  onFailure: "keep",
});

async function runOp(extra: Partial<ClickHouseRebuildDeps> = {}): Promise<OpRunResult> {
  const props = (ClickHouseRebuildOp(opConfig()).op as unknown as { props: OpConfig }).props;
  const activities = new Map<string, ActivityFn>();
  for (const [name, fn] of Object.entries(rebuildActivities)) {
    if (typeof fn !== "function" || !name.startsWith("clickhouseRebuild")) continue;
    activities.set(name, ((args: Record<string, unknown>, signal?: AbortSignal) => (fn as (a: unknown, s?: AbortSignal, d?: unknown) => Promise<unknown>)(args, signal, deps(extra))) as ActivityFn);
  }
  // One attempt per step, so the failure below fails the run where it happens.
  const profiles = Object.fromEntries(Object.entries(await loadProfiles()).map(([k, v]) => [k, { ...v, retry: { maximumAttempts: 1 } }]));
  return runOpLocally(props, activities, profiles, undefined, { gates: memoryGateLedgerPort(), now: new Date().toISOString() });
}

const outcome = (r: OpRunResult, name: string) => r.records.flatMap((x) => x.outcomes ?? []).find((o) => o.name === name)?.value;

describe.skipIf(!enabled)("a rebuild on a cluster of two shards (#3663)", () => {
  test("every shard's rows survive the rebuild, and a rerun after a failure on shard 2 skips what was copied", async () => {
    const applied = normalizeApply(toApplyResult(await clickhouseApply({ buildPath: join(dir, writeBuild("events-v1.json", "(ts, user_id)")), environment: "e2e" }, undefined, deps())));
    expect(applied.notAttempted).toEqual([]);
    // Each shard's own rows, three days of them, written on that shard.
    const [s1] = servers("s1");
    const [s2] = servers("s2");
    await q(s1!, "INSERT INTO shop.events SELECT toDateTime('2026-02-01 00:00:00') + (number % 3) * 86400 + number, number, 'view' FROM numbers(30)");
    await q(s2!, "INSERT INTO shop.events SELECT toDateTime('2026-02-01 00:00:00') + (number % 3) * 86400 + number, 1000 + number, 'click' FROM numbers(24)");
    expect(await count(s1!, "shop.events_all")).toBe(54);
    writeBuild("events-v2.json", "(user_id, ts)");

    // Shard 2's first partition is copied and its receipt written, then the backfill fails.
    const failure = await runOp({
      backfill: {
        afterPartition: (_p, shard) => {
          if (shard === 2) throw new Error("the backfill failed on shard 2");
        },
      },
    }).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(failure).toBeInstanceOf(OpRunFailure);
    expect((failure as OpRunFailure).result.records.find((x) => x.fn === "clickhouseRebuildBackfill")?.error).toMatch(/failed on shard 2/);
    const receipts = async () =>
      (await q<{ address: string }>(s1!, "SELECT DISTINCT address FROM chant_receipts.receipts WHERE address LIKE 'e2e/test/rebuild/shop.events/%' ORDER BY address")).map((r) => r.address);
    expect(await receipts()).toEqual([
      "e2e/test/rebuild/shop.events/shard1/20260201",
      "e2e/test/rebuild/shop.events/shard1/20260202",
      "e2e/test/rebuild/shop.events/shard1/20260203",
      "e2e/test/rebuild/shop.events/shard2/20260201",
    ]);
    // Each shard's new table holds that shard's copied rows, and nothing of the other's.
    expect(await count(s1!, "shop.events__chant_new")).toBe(30);
    expect(await count(s2!, "shop.events__chant_new")).toBe(8);

    // The rerun resumes: four (shard, partition) copies skipped, two copied, every row verified, swapped.
    const r = await runOp();
    expect(r.status).toBe("ok");
    expect(outcome(r, "Skipped")).toBe(4);
    expect(outcome(r, "Copied")).toBe(2);
    expect(outcome(r, "VerifiedRows")).toBe(54);
    expect(outcome(r, "VerifiedPartitions")).toBe(6);

    for (const [shard, rows] of [["s1", 30], ["s2", 24]] as const) {
      for (const server of servers(shard)) {
        await q(server, "SYSTEM SYNC REPLICA shop.events");
        expect(await count(server, "shop.events")).toBe(rows);
        expect((await q<{ statement: string }>(server, "SHOW CREATE TABLE shop.events"))[0]!.statement).toMatch(/ORDER BY \(user_id, ts\)/);
        expect(await count(server, "shop.events__chant_old")).toBe(rows);
      }
    }
    expect(await count(s1!, "shop.events_all")).toBe(54);
  }, 600_000);
});
