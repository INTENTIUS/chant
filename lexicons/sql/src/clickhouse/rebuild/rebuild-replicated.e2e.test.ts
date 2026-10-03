/**
 * The rebuild migration on a Replicated database (#3249): two replicas of the
 * pinned server, Keeper embedded in the first, a `Replicated` database and
 * `ReplicatedMergeTree` tables.
 *
 * - Through its gates, with the runs moving between replicas: created and
 *   filled on one, re-run on the other (which reads the first one's receipts
 *   and copies nothing again), swapped there, dropped back on the first. The
 *   EXCHANGE, the dependent view's DETACH and ATTACH and the drop reach every
 *   replica, and a plan on either finds the declaration.
 * - An interrupted backfill resumed on the other replica: the copy still
 *   running on the first replica under the partition's query id is killed
 *   from the second, the partition it left half copied and the one killed
 *   before its receipt are cleared and copied again (not dropped as repeated
 *   blocks), and the verification finds every row once.
 * - A replica down (#3270), last because it restarts a container: with a
 *   part on the stopped replica alone, the backfill waits, then stops naming
 *   it, and onFailure drops the new table without waiting for it; restarted,
 *   the part reaches the other replica. Then stopped in the middle of a
 *   backfill: the run goes on with the live replica through both gates, and
 *   the restarted replica catches up from Keeper with every row and the
 *   declaration, and plans no change.
 *
 * Runs the Op through core's local executor with an in-memory gate ledger.
 * Needs Docker; skips cleanly without it.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { normalizeApply } from "@intentius/chant/apply";
import { memoryGateLedgerPort, runOpLocally, loadProfiles, OpRunFailure, type ActivityFn, type GateLedgerPort, type OpConfig, type OpRunResult } from "@intentius/chant/op";
import { dockerAvailable, startScratchCluster, type ScratchCluster } from "../container";
import { clickhouseQuery, type ClickHouseEndpoint } from "../http";
import { clickhouseImage } from "../../spec/pin";
import { planAgainstServer } from "../plan/commands";
import { clickhouseApply, toApplyResult } from "../../op/activities/clickhouse-apply";
import * as rebuildActivities from "../../op/activities/clickhouse-rebuild";
import type { ClickHouseRebuildDeps } from "../../op/activities/clickhouse-rebuild";
import { ClickHouseRebuildOp, type ClickHouseRebuildOpConfig } from "./op";
import { clickhouseReceiptStore, REPLICATED_RECEIPTS_TABLE, type ClickHouseReceiptStore } from "./receipts";

const enabled = await dockerAvailable();
let cluster: ScratchCluster | undefined;
const dir = mkdtempSync(join(tmpdir(), "chant-sql-rebuild-replicated-"));

beforeAll(async () => {
  if (!enabled) return;
  cluster = await startScratchCluster(clickhouseImage(), { replicas: 2, namePrefix: "chant-sql-rebuild-repl" });
}, 600_000);

afterAll(async () => {
  await cluster?.stop();
  rmSync(dir, { recursive: true, force: true });
});

interface Obj {
  export: string;
  type: string;
  ddl: string;
  dependsOn?: string[];
}

function writeBuild(file: string, objects: Obj[]): string {
  writeFileSync(join(dir, file), JSON.stringify({ dialect: "clickhouse", applyOrder: objects.map((o) => o.export), objects: objects.map((o) => ({ dependsOn: [], ...o })) }));
  return file;
}

const MARKER = { stack: "e2e", env: "test" };
const r1 = (): ClickHouseEndpoint => cluster!.replicas[0]!;
const r2 = (): ClickHouseEndpoint => cluster!.replicas[1]!;
const deps = (at: ClickHouseEndpoint) => ({ config: { ownership: MARKER }, env: { CLICKHOUSE_URL: at.url }, log: () => undefined });
const q = <T = Record<string, unknown>>(at: ClickHouseEndpoint, sql: string) => clickhouseQuery<T>(at, sql);
/** Rows of a table on one replica, once it has fetched what the others wrote. */
async function count(at: ClickHouseEndpoint, table: string, where = ""): Promise<number> {
  await q(at, `SYSTEM SYNC REPLICA ${table} LIGHTWEIGHT`);
  return Number((await q<{ n: string }>(at, `SELECT count() AS n FROM ${table}${where ? ` WHERE ${where}` : ""}`))[0]!.n);
}
/**
 * A replica that has just started again: wait until it has replayed the
 * database's log. It answers queries before it is back in Keeper as a
 * database replica, and says it is read-only until then.
 */
async function catchUp(at: ClickHouseEndpoint, database: string): Promise<void> {
  const deadline = Date.now() + 120_000;
  for (;;) {
    try {
      await q(at, `SYSTEM SYNC DATABASE REPLICA ${database}`);
      return;
    } catch (err) {
      console.log(`catchUp ${database}: ${(err as Error).message}`, JSON.stringify(await q(at, "SELECT * FROM system.database_replicas").catch((e: unknown) => String(e))));
      if (Date.now() > deadline) throw err;
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
}
async function exists(at: ClickHouseEndpoint, database: string, name: string): Promise<boolean> {
  await q(at, `SYSTEM SYNC DATABASE REPLICA ${database}`);
  return Number((await q<{ n: string }>(at, `SELECT count() AS n FROM system.tables WHERE database = '${database}' AND name = '${name}'`))[0]!.n) > 0;
}
const showCreate = async (at: ClickHouseEndpoint, name: string) => (await q<{ statement: string }>(at, `SHOW CREATE TABLE ${name}`))[0]!.statement;

function activities(at: ClickHouseEndpoint, extra: Partial<ClickHouseRebuildDeps> = {}): Map<string, ActivityFn> {
  const map = new Map<string, ActivityFn>();
  for (const [name, fn] of Object.entries(rebuildActivities)) {
    if (typeof fn !== "function" || !name.startsWith("clickhouseRebuild")) continue;
    map.set(name, ((args: Record<string, unknown>, signal?: AbortSignal) =>
      (fn as (a: unknown, s?: AbortSignal, d?: unknown) => Promise<unknown>)(args, signal, { ...deps(at), ...extra })) as ActivityFn);
  }
  return map;
}

/** One run of the Op against one replica. */
async function runOp(at: ClickHouseEndpoint, config: ClickHouseRebuildOpConfig, gates: GateLedgerPort, extra: Partial<ClickHouseRebuildDeps> = {}): Promise<OpRunResult> {
  const { op } = ClickHouseRebuildOp(config);
  const props = (op as unknown as { props: OpConfig }).props;
  return runOpLocally(props, activities(at, extra), await loadProfiles(), undefined, { gates, now: new Date().toISOString() });
}

class Ledger {
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

const outcome = (r: OpRunResult, name: string) => r.records.flatMap((x) => x.outcomes ?? []).find((o) => o.name === name)?.value;

const DB_DDL = "CREATE DATABASE shop ENGINE = Replicated('/clickhouse/databases/shop', '{shard}', '{replica}')";
const DB: Obj = { export: "shop", type: "ClickHouse::Database", ddl: DB_DDL };

/** The applier makes the database on the first replica; each other replica joins it with the same statement. */
async function joinDatabase(at: ClickHouseEndpoint): Promise<void> {
  await q(at, DB_DDL.replace("CREATE DATABASE", "CREATE DATABASE IF NOT EXISTS"));
  await q(at, "SYSTEM SYNC DATABASE REPLICA shop");
}

const eventsDdl = (orderBy: string) => `CREATE TABLE shop.events
(
  ts DateTime,
  user_id UInt64,
  kind LowCardinality(String)
)
ENGINE = ReplicatedMergeTree
PARTITION BY toYYYYMM(ts)
ORDER BY ${orderBy}
COMMENT 'Raw events'`;
const EVENTS_V1: Obj = { export: "events", type: "ClickHouse::Table", dependsOn: ["shop"], ddl: eventsDdl("(ts, user_id)") };
const EVENTS_V2: Obj = { ...EVENTS_V1, ddl: eventsDdl("(user_id, ts)") };
const DAILY: Obj = {
  export: "daily",
  type: "ClickHouse::Table",
  dependsOn: ["shop"],
  ddl: "CREATE TABLE shop.daily (day Date, n UInt64) ENGINE = ReplicatedSummingMergeTree ORDER BY day",
};
const DAILY_MV: Obj = {
  export: "dailyMv",
  type: "ClickHouse::MaterializedView",
  dependsOn: ["events", "daily"],
  ddl: "CREATE MATERIALIZED VIEW shop.daily_mv TO shop.daily AS SELECT toDate(ts) AS day, count() AS n FROM shop.events GROUP BY day",
};

describe.skipIf(!enabled)("a sorting-key change on a Replicated database, rebuilt through its gates across replicas", () => {
  const config = (): ClickHouseRebuildOpConfig => ({
    name: "rebuild-events",
    env: "e2e",
    table: "shop.events",
    dualWrite: { mode: "materialized-view", cutoverColumn: "ts", cutoverDelay: "2s" },
    build: false,
    path: dir,
    output: "events-v2.json",
    retain: "0s",
    stack: MARKER.stack,
    ownershipEnv: MARKER.env,
  });
  const ledger = new Ledger();

  test("the plan on either replica finds only the sorting key, and the applier refuses it", async () => {
    const v1 = writeBuild("events-v1.json", [DB, EVENTS_V1, DAILY, DAILY_MV]);
    const applied = normalizeApply(toApplyResult(await clickhouseApply({ buildPath: join(dir, v1), environment: "e2e" }, undefined, deps(r1()))));
    expect(applied.notAttempted).toEqual([]);
    await joinDatabase(r2());
    expect(await exists(r2(), "shop", "daily_mv")).toBe(true);
    await q(r1(), "INSERT INTO shop.events SELECT toDateTime('2026-01-01 00:00:00') + number * 6480, number % 50, if(number % 3 = 0, 'click', 'view') FROM numbers(1600)");

    const v2 = writeBuild("events-v2.json", [DB, EVENTS_V2, DAILY, DAILY_MV]);
    for (const at of [r1(), r2()]) {
      // ENGINE = ReplicatedMergeTree reads back with the default Keeper path and replica filled in; that is no change.
      const plan = await planAgainstServer("e2e", join(dir, v2), { config: {}, env: { CLICKHOUSE_URL: at.url } });
      expect(plan.changes.map((c) => c.rule)).toEqual(["SQLCH220"]);
      expect(plan.rebuildOps).toEqual([expect.objectContaining({ table: "shop.events" })]);
    }
    const refused = normalizeApply(toApplyResult(await clickhouseApply({ buildPath: join(dir, v2), environment: "e2e" }, undefined, deps(r2()))));
    expect(refused.notAttempted).toEqual([expect.objectContaining({ name: "shop.events", reason: "unsupported-kind" })]);
  }, 180_000);

  test("filled on one replica, re-run on the other: the receipts replicate and nothing is copied twice", async () => {
    const r = await runOp(r1(), config(), ledger.port);
    expect(r.status).toBe("gated");
    expect(r.gate).toMatchObject({ gate: "approve-rebuild-events" });
    expect(outcome(r, "VerifiedRows")).toBe(1600);
    expect(outcome(r, "VerifiedPartitions")).toBe(4);
    // The new table, the dual-write view and the receipts are on both replicas, rows and all.
    expect(await count(r2(), "shop.events__chant_new")).toBe(1600);
    expect(await exists(r2(), "shop", "events__chant_dual")).toBe(true);
    expect(await count(r2(), `shop.${REPLICATED_RECEIPTS_TABLE}`)).toBe(4);
    expect(await q(r1(), "SELECT name FROM system.databases WHERE name = 'chant_receipts'")).toEqual([]);

    // A write on the second replica reaches the new table through its copy of the dual-write view.
    await q(r2(), "INSERT INTO shop.events VALUES (now() + 3600, 7, 'click')");
    expect(await count(r1(), "shop.events__chant_new")).toBe(1601);

    // The second replica reads the receipts the first one wrote: the four
    // partitions are skipped, the new one (after the cut-over) copies nothing,
    // and the gate stands as it was.
    const again = await runOp(r2(), config(), ledger.port);
    expect(again.status).toBe("gated");
    expect(outcome(again, "Skipped")).toBe(4);
    expect(outcome(again, "Copied")).toBe(1);
    expect(again.gate!.planDigest).toBe(r.gate!.planDigest);
    expect(await count(r1(), "shop.events__chant_new")).toBe(1601);
  }, 300_000);

  test("approved, the swap on the second replica reaches the first, view and all", async () => {
    ledger.approveLast();
    const r = await runOp(r2(), config(), ledger.port);
    expect(r.status).toBe("gated");
    expect(r.gate).toMatchObject({ gate: "approve-rebuild-events-drop" });
    expect(outcome(r, "Dependents")).toEqual(["shop.daily_mv"]);

    for (const at of [r1(), r2()]) {
      await q(at, "SYSTEM SYNC DATABASE REPLICA shop");
      expect(await showCreate(at, "shop.events")).toMatch(/ReplicatedMergeTree[\s\S]*ORDER BY \(user_id, ts\)/);
      expect(await count(at, "shop.events")).toBe(1601);
      expect(await count(at, "shop.events__chant_old")).toBe(1601);
      expect(await exists(at, "shop", "events__chant_dual")).toBe(false);
      expect(await exists(at, "shop", "events__chant_new")).toBe(false);
      expect(await exists(at, "shop", "daily_mv")).toBe(true);
      const [{ comment }] = await q<{ comment: string }>(at, "SELECT comment FROM system.tables WHERE database = 'shop' AND name = 'events'");
      expect(comment).toBe("Raw events [chant managed-by=chant stack=e2e env=test]");
    }

    // The view, detached and attached again on every replica, reads the new table on each.
    const before = Number((await q<{ n: string }>(r2(), "SELECT sum(n) AS n FROM shop.daily"))[0]!.n);
    await q(r1(), "INSERT INTO shop.events VALUES (now(), 8, 'view')");
    await q(r2(), "INSERT INTO shop.events VALUES (now(), 9, 'view')");
    await q(r2(), "SYSTEM SYNC REPLICA shop.daily LIGHTWEIGHT");
    expect(Number((await q<{ n: string }>(r2(), "SELECT sum(n) AS n FROM shop.daily"))[0]!.n)).toBe(before + 2);
  }, 300_000);

  test("approved again, the drop on the first replica leaves the declaration on both", async () => {
    ledger.approveLast();
    const r = await runOp(r1(), config(), ledger.port);
    expect(r.status).toBe("ok");
    expect(outcome(r, "Dropped")).toBe(true);
    for (const at of [r1(), r2()]) {
      expect(await exists(at, "shop", "events__chant_old")).toBe(false);
      const plan = await planAgainstServer("e2e", join(dir, "events-v2.json"), { config: {}, env: { CLICKHOUSE_URL: at.url } });
      expect(plan.changes).toEqual([]);
    }
    const done = await runOp(r2(), config(), ledger.port);
    expect(done.status).toBe("ok");
    expect(outcome(done, "RebuildState")).toBe("done");
  }, 300_000);
});

describe.skipIf(!enabled)("an interrupted backfill resumes on the other replica", () => {
  const viewsDdl = (orderBy: string) =>
    `CREATE TABLE shop.page_views (day Date, page String, n UInt32) ENGINE = ReplicatedMergeTree PARTITION BY day ORDER BY ${orderBy}`;
  const V1: Obj = { export: "pageViews", type: "ClickHouse::Table", dependsOn: ["shop"], ddl: viewsDdl("(day, page)") };
  const V2: Obj = { ...V1, ddl: viewsDdl("(page, day)") };
  const args = () => ({
    table: "shop.page_views",
    buildPath: "views-v2.json",
    environment: "e2e",
    dualWrite: { mode: "app" as const },
    stack: MARKER.stack,
    ownershipEnv: MARKER.env,
    cwd: dir,
  });

  test("stopped, killed before a receipt, a copy left running on the first replica: the second kills it and finishes, every row once", async () => {
    await clickhouseApply({ buildPath: join(dir, writeBuild("views-v1.json", [DB, V1])), environment: "e2e" }, undefined, deps(r1()));
    await joinDatabase(r2());
    await q(r1(), "INSERT INTO shop.page_views SELECT toDate('2026-03-01') + number % 6, concat('/p/', toString(number % 11)), number FROM numbers(6000)");
    writeBuild("views-v2.json", [DB, V2]);
    await rebuildActivities.clickhouseRebuildCreate(args(), undefined, deps(r1()));

    // On the first replica: interrupted after the second partition.
    const stop = new AbortController();
    let done = 0;
    const interrupted = await rebuildActivities
      .clickhouseRebuildBackfill(args(), stop.signal, { ...deps(r1()), backfill: { afterPartition: () => void (++done === 2 && stop.abort()) } })
      .then(
        () => undefined,
        (e: unknown) => e,
      );
    expect(interrupted).toBeDefined();

    // Then killed between the third partition's INSERT and its receipt.
    const real = clickhouseReceiptStore(r1(), MARKER, { replicatedIn: "shop" });
    const crashing: ClickHouseReceiptStore = {
      ...real,
      write: async () => {
        throw new Error("killed before the receipt");
      },
    };
    await expect(rebuildActivities.clickhouseRebuildBackfill(args(), undefined, { ...deps(r1()), backfill: { receipts: crashing } })).rejects.toThrow(/killed before the receipt/);
    expect(await count(r1(), "shop.page_views__chant_new")).toBe(3000);

    // And the fourth partition's copy still running on the first replica
    // under its query id, its client gone, a block at a time.
    const [{ uuid }] = await q<{ uuid: string }>(r1(), "SELECT toString(uuid) AS uuid FROM system.tables WHERE database = 'shop' AND name = 'page_views__chant_new'");
    const fourth = "20260304";
    const params = new URLSearchParams({
      query_id: `chant-rebuild-${uuid}-${fourth}`,
      max_block_size: "10",
      min_insert_block_size_rows: "10",
      min_insert_block_size_bytes: "1",
      max_insert_block_size: "10",
    });
    const running = fetch(`${r1().url}/?${params}`, {
      method: "POST",
      body: "INSERT INTO shop.page_views__chant_new (day, page, n) SELECT toDate('2026-03-04'), '/stray', number FROM numbers(1000) WHERE sleepEachRow(0.05) = 0",
    }).then((res) => res.text());
    for (let i = 0; (await count(r1(), "shop.page_views__chant_new", "day = '2026-03-04'")) === 0; i++) {
      if (i > 100) throw new Error("the stray copy wrote nothing");
      await new Promise((r) => setTimeout(r, 100));
    }

    // Resumed on the second replica: two partitions skipped by the receipts
    // the first replica wrote, the third and the fourth cleared and copied
    // again, two more copied.
    const resumed = await rebuildActivities.clickhouseRebuildBackfill(args(), undefined, deps(r2()));
    expect(resumed).toMatchObject({ partitions: 6, skipped: 2, cleared: 2, copied: 4 });
    expect(await running).toMatch(/QUERY_WAS_CANCELLED/);
    for (const at of [r1(), r2()]) {
      expect(await count(at, "shop.page_views__chant_new")).toBe(6000);
      expect(await count(at, "shop.page_views__chant_new", "page = '/stray'")).toBe(0);
    }

    const verified = await rebuildActivities.clickhouseRebuildVerify(args(), undefined, deps(r1()));
    expect(verified).toMatchObject({ partitions: 6, rows: 6000 });
    await q(r1(), `SYSTEM SYNC REPLICA shop.${REPLICATED_RECEIPTS_TABLE} LIGHTWEIGHT`);
    const receipts = await q<{ address: string }>(r1(), `SELECT DISTINCT address FROM shop.${REPLICATED_RECEIPTS_TABLE} WHERE address LIKE 'e2e/test/rebuild/shop.page_views/%'`);
    expect(receipts).toHaveLength(6);

    // The receipts table is chant's bookkeeping, not part of the declared schema.
    const plan = await planAgainstServer("e2e", join(dir, "views-v2.json"), { config: {}, env: { CLICKHOUSE_URL: r2().url } });
    expect(plan.changes.map((c) => c.object)).not.toContain(`shop.${REPLICATED_RECEIPTS_TABLE}`);

    const dropped = await rebuildActivities.clickhouseRebuildCompensate(args(), undefined, deps(r2()));
    expect(dropped.dropped).toEqual(["shop.page_views__chant_new"]);
    expect(await exists(r1(), "shop", "page_views__chant_new")).toBe(false);
  }, 300_000);
});

describe.skipIf(!enabled)("a table that does not replicate its rows is refused", () => {
  const plainDdl = (orderBy: string) => `CREATE TABLE shop.plain (id UInt64, url String) ENGINE = MergeTree ORDER BY ${orderBy}`;
  const V1: Obj = { export: "plain", type: "ClickHouse::Table", dependsOn: ["shop"], ddl: plainDdl("id") };
  const V2: Obj = { ...V1, ddl: plainDdl("(url, id)") };

  test("a MergeTree in a Replicated database keeps its rows per replica, so the plan refuses it and makes nothing", async () => {
    await clickhouseApply({ buildPath: join(dir, writeBuild("plain-v1.json", [DB, V1])), environment: "e2e" }, undefined, deps(r1()));
    writeBuild("plain-v2.json", [DB, V2]);
    const args = { table: "shop.plain", buildPath: "plain-v2.json", environment: "e2e", dualWrite: { mode: "app" as const }, stack: MARKER.stack, ownershipEnv: MARKER.env, cwd: dir };
    await expect(rebuildActivities.clickhouseRebuildPlan(args, undefined, deps(r2()))).rejects.toThrow(
      /shop\.plain is in a Replicated database and the table is MergeTree, which keeps a separate set of rows on each replica/,
    );
    expect(await exists(r1(), "shop", "plain__chant_new")).toBe(false);
  }, 120_000);
});

describe.skipIf(!enabled)("a replica down (#3270)", () => {
  const clicksDdl = (orderBy: string) => `CREATE TABLE depot.clicks
(
  ts DateTime,
  user_id UInt64,
  page String
)
ENGINE = ReplicatedMergeTree
PARTITION BY toYYYYMM(ts)
ORDER BY ${orderBy}`;
  const V1: Obj = { export: "clicks", type: "ClickHouse::Table", dependsOn: ["depot"], ddl: clicksDdl("(ts, user_id)") };
  const V2: Obj = { ...V1, ddl: clicksDdl("(user_id, ts)") };
  const PER_DAY: Obj = {
    export: "clicksDaily",
    type: "ClickHouse::Table",
    dependsOn: ["depot"],
    ddl: "CREATE TABLE depot.clicks_daily (day Date, n UInt64) ENGINE = ReplicatedSummingMergeTree ORDER BY day",
  };
  const PER_DAY_MV: Obj = {
    export: "clicksDailyMv",
    type: "ClickHouse::MaterializedView",
    dependsOn: ["clicks", "clicksDaily"],
    ddl: "CREATE MATERIALIZED VIEW depot.clicks_daily_mv TO depot.clicks_daily AS SELECT toDate(ts) AS day, count() AS n FROM depot.clicks GROUP BY day",
  };
  const config = (extra: Partial<ClickHouseRebuildOpConfig> = {}): ClickHouseRebuildOpConfig => ({
    name: "rebuild-clicks",
    env: "e2e",
    table: "depot.clicks",
    dualWrite: { mode: "materialized-view", cutoverColumn: "ts", cutoverDelay: "2s" },
    build: false,
    path: dir,
    output: "clicks-v2.json",
    retain: "0s",
    stack: MARKER.stack,
    ownershipEnv: MARKER.env,
    ...extra,
  });
  const ledger = new Ledger();
  // Its own database, so the plans below read only these tables.
  const DEPOT_DDL = "CREATE DATABASE depot ENGINE = Replicated('/clickhouse/databases/depot', '{shard}', '{replica}')";
  const DEPOT: Obj = { export: "depot", type: "ClickHouse::Database", ddl: DEPOT_DDL };
  const stepError = (err: unknown, fn: string) => (err as OpRunFailure).result.records.find((r) => r.fn === fn && r.status === "fail")?.error ?? "";

  test("a part on the stopped replica alone: the backfill waits, stops naming it, and onFailure goes on without it", async () => {
    await clickhouseApply({ buildPath: join(dir, writeBuild("clicks-v1.json", [DEPOT, V1, PER_DAY, PER_DAY_MV])), environment: "e2e" }, undefined, deps(r1()));
    await q(r2(), DEPOT_DDL.replace("CREATE DATABASE", "CREATE DATABASE IF NOT EXISTS"));
    await q(r2(), "SYSTEM SYNC DATABASE REPLICA depot");
    writeBuild("clicks-v2.json", [DEPOT, V2, PER_DAY, PER_DAY_MV]);
    await q(r1(), "INSERT INTO depot.clicks SELECT toDateTime('2026-01-01 00:00:00') + number * 6480, number % 50, concat('/p/', toString(number % 7)) FROM numbers(1600)");
    expect(await count(r2(), "depot.clicks")).toBe(1600);

    // Forty rows written on r2 that r1 has not fetched when r2 stops.
    await q(r1(), "SYSTEM STOP FETCHES depot.clicks");
    await q(r2(), "INSERT INTO depot.clicks SELECT toDateTime('2026-02-10 00:00:00') + number * 60, 1000 + number, '/late' FROM numbers(40)");
    await cluster!.stopReplica(1);
    await q(r1(), "SYSTEM START FETCHES depot.clicks");

    // Create and Dual write go on without r2 (it is skipped once Keeper sees it
    // inactive); the backfill cannot read r2's part and stops; onFailure's
    // drops go on without r2 too.
    const failed = await runOp(r1(), config({ replicaTimeout: "3s" }), ledger.port).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(failed).toBeInstanceOf(OpRunFailure);
    expect(stepError(failed, "clickhouseRebuildBackfill")).toMatch(
      /depot\.clicks: waited \d+s for replica r1 to fetch what the other replicas wrote, and 1 part\(s\) are still to fetch: 202602_\S+ from r2.*Those rows are on r2 alone/,
    );
    expect((failed as OpRunFailure).result.records.find((r) => r.fn === "clickhouseRebuildCompensate")?.status).toBe("ok");
    expect(await q(r1(), "SELECT name FROM system.tables WHERE database = 'depot' AND name LIKE 'clicks\\_\\_chant%'")).toEqual([]);
    expect(Number((await q<{ n: string }>(r1(), "SELECT count() AS n FROM depot.clicks"))[0]!.n)).toBe(1600);

    // Back up: r1 fetches the part, and r2 replays the create and the drops from the database's log.
    await cluster!.startReplica(1);
    expect(await count(r1(), "depot.clicks")).toBe(1640);
    await catchUp(r2(), "depot");
    expect(await q(r2(), "SELECT name FROM system.tables WHERE database = 'depot' AND name LIKE 'clicks\\_\\_chant%'")).toEqual([]);
  }, 300_000);

  test("stopped mid-backfill, the run goes on with the live replica through both gates, and the replica catches up when it is back", async () => {
    let stopped = false;
    const stopAfterFirst = {
      backfill: {
        afterPartition: async () => {
          if (stopped) return;
          stopped = true;
          await cluster!.stopReplica(1);
        },
      },
    };
    const r = await runOp(r1(), config(), ledger.port, stopAfterFirst);
    expect(stopped).toBe(true);
    expect(r.status).toBe("gated");
    expect(r.gate).toMatchObject({ gate: "approve-rebuild-clicks" });
    expect(outcome(r, "VerifiedRows")).toBe(1640);
    expect(outcome(r, "Copied")).toBe(4);

    // Approved with r2 still down: EXCHANGE, the view's DETACH PERMANENTLY and ATTACH, the drop.
    ledger.approveLast();
    const swapped = await runOp(r1(), config(), ledger.port);
    expect(swapped.status).toBe("gated");
    expect(swapped.gate).toMatchObject({ gate: "approve-rebuild-clicks-drop" });
    expect(outcome(swapped, "Dependents")).toEqual(["depot.clicks_daily_mv"]);
    ledger.approveLast();
    const dropped = await runOp(r1(), config(), ledger.port);
    expect(dropped.status).toBe("ok");
    expect(outcome(dropped, "Dropped")).toBe(true);

    // Back up: r2 replays the database's log and fetches the new table's parts.
    await cluster!.startReplica(1);
    await catchUp(r2(), "depot");
    for (const at of [r1(), r2()]) {
      expect(await showCreate(at, "depot.clicks")).toMatch(/ORDER BY \(user_id, ts\)/);
      expect(await count(at, "depot.clicks")).toBe(1640);
      expect(await count(at, "depot.clicks", "page = '/late'")).toBe(40);
      expect(await q(at, "SELECT name FROM system.tables WHERE database = 'depot' AND name LIKE 'clicks\\_\\_chant%'")).toEqual([]);
      const plan = await planAgainstServer("e2e", join(dir, "clicks-v2.json"), { config: {}, env: { CLICKHOUSE_URL: at.url } });
      expect(plan.changes).toEqual([]);
    }
    // The view, re-attached while r2 was down, counts an insert on r2.
    await q(r2(), "INSERT INTO depot.clicks VALUES (now(), 1, '/after')");
    await q(r1(), "SYSTEM SYNC REPLICA depot.clicks_daily LIGHTWEIGHT");
    expect(Number((await q<{ n: string }>(r1(), "SELECT sum(n) AS n FROM depot.clicks_daily WHERE day = today()"))[0]!.n)).toBeGreaterThanOrEqual(1);
  }, 300_000);
});
