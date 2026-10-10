/**
 * The rebuild migration against the pinned server (#3198).
 *
 * - A sorting-key change: the plan and the applier refuse it and name the
 *   Op; the Op stops at its gate with the verification on the run record,
 *   swaps once approved, recreates the materialized view that reads the
 *   table, keeps the old table, and drops it at the second gate.
 * - A failure: rows that land in the old table after the backfill fail the
 *   verification, and onFailure drops the new table.
 * - Rows dated after the cut-over (sql-yodeler#45): the ones the table held
 *   before the view are copied by the backfill, the ones written during the
 *   rebuild arrive through the view, and the swap leaves none behind.
 * - Under an outer approval with the new table kept on failure (#3658): a
 *   backfill that fails part way leaves the new table and its receipts, and
 *   the next run skips the partitions already copied, verifies and swaps
 *   with no gate, and keeps the old table.
 * - An interrupted backfill: stopped after three partitions, then killed
 *   between a partition's INSERT and its receipt, then resumed: the receipts
 *   skip what was copied, the half-copied partition is cleared first, and the
 *   verification finds every row once.
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
import { dockerAvailable, startScratchServer, type ScratchServer } from "../container";
import { clickhouseQuery } from "../http";
import { clickhouseImage } from "../../spec/pin";
import { planAgainstServer } from "../plan/commands";
import { clickhouseApply, toApplyResult } from "../../op/activities/clickhouse-apply";
import * as rebuildActivities from "../../op/activities/clickhouse-rebuild";
import type { ClickHouseRebuildDeps } from "../../op/activities/clickhouse-rebuild";
import { ClickHouseRebuildOp, type ClickHouseRebuildOpConfig } from "./op";
import { clickhouseReceiptStore, RECEIPTS_DATABASE, RECEIPTS_TABLE, type ClickHouseReceiptStore } from "./receipts";

const enabled = await dockerAvailable();
let server: ScratchServer | undefined;
const dir = mkdtempSync(join(tmpdir(), "chant-sql-rebuild-"));

beforeAll(async () => {
  if (!enabled) return;
  server = await startScratchServer(clickhouseImage(), { namePrefix: "chant-sql-rebuild" });
}, 600_000);

afterAll(async () => {
  await server?.stop();
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
const deps = () => ({ config: { ownership: MARKER }, env: { CLICKHOUSE_URL: server!.endpoint.url }, log: () => undefined });
const q = <T = Record<string, unknown>>(sql: string) => clickhouseQuery<T>(server!.endpoint, sql);
const count = async (table: string) => Number((await q<{ n: string }>(`SELECT count() AS n FROM ${table}`))[0]!.n);
const exists = async (database: string, name: string) => Number((await q<{ n: string }>(`SELECT count() AS n FROM system.tables WHERE database = '${database}' AND name = '${name}'`))[0]!.n) > 0;
const showCreate = async (name: string) => (await q<{ statement: string }>(`SHOW CREATE TABLE ${name}`))[0]!.statement;

/** The rebuild activities, with the test's config, server and a quiet log, as the local executor resolves them. */
function activities(extra: Partial<ClickHouseRebuildDeps> = {}): Map<string, ActivityFn> {
  const map = new Map<string, ActivityFn>();
  for (const [name, fn] of Object.entries(rebuildActivities)) {
    if (typeof fn !== "function" || !name.startsWith("clickhouseRebuild")) continue;
    map.set(name, ((args: Record<string, unknown>, signal?: AbortSignal) =>
      (fn as (a: unknown, s?: AbortSignal, d?: unknown) => Promise<unknown>)(args, signal, { ...deps(), ...extra })) as ActivityFn);
  }
  return map;
}

async function runOp(config: ClickHouseRebuildOpConfig, gates: GateLedgerPort, extra: Partial<ClickHouseRebuildDeps> = {}): Promise<OpRunResult> {
  const { op } = ClickHouseRebuildOp(config);
  const props = (op as unknown as { props: OpConfig }).props;
  return runOpLocally(props, activities(extra), await loadProfiles(), undefined, { gates, now: new Date().toISOString() });
}

/** An in-memory gate ledger a person approves on: each approval answers the gate the last run stopped at, for the plan it recorded. */
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

const DB: Obj = { export: "shop", type: "ClickHouse::Database", ddl: "CREATE DATABASE shop ENGINE = Atomic" };
const eventsDdl = (orderBy: string) => `CREATE TABLE shop.events
(
  ts DateTime,
  user_id UInt64,
  kind LowCardinality(String)
)
ENGINE = MergeTree
PARTITION BY toYYYYMM(ts)
ORDER BY ${orderBy}
COMMENT 'Raw events'`;
const EVENTS_V1: Obj = { export: "events", type: "ClickHouse::Table", dependsOn: ["shop"], ddl: eventsDdl("(ts, user_id)") };
const EVENTS_V2: Obj = { ...EVENTS_V1, ddl: eventsDdl("(user_id, ts)") };
const DAILY: Obj = {
  export: "daily",
  type: "ClickHouse::Table",
  dependsOn: ["shop"],
  ddl: "CREATE TABLE shop.daily (day Date, n UInt64) ENGINE = SummingMergeTree ORDER BY day",
};
const DAILY_MV: Obj = {
  export: "dailyMv",
  type: "ClickHouse::MaterializedView",
  dependsOn: ["events", "daily"],
  ddl: "CREATE MATERIALIZED VIEW shop.daily_mv TO shop.daily AS SELECT toDate(ts) AS day, count() AS n FROM shop.events GROUP BY day",
};

describe.skipIf(!enabled)("a sorting-key change, rebuilt through its gates", () => {
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

  test("the plan and the applier refuse the change in place and name the Op", async () => {
    const v1 = writeBuild("events-v1.json", [DB, EVENTS_V1, DAILY, DAILY_MV]);
    const applied = normalizeApply(toApplyResult(await clickhouseApply({ buildPath: join(dir, v1), environment: "e2e" }, undefined, deps())));
    expect(applied.notAttempted).toEqual([]);
    // Four months of rows, all well before any cut-over.
    await q("INSERT INTO shop.events SELECT toDateTime('2026-01-01 00:00:00') + number * 6480, number % 50, if(number % 3 = 0, 'click', 'view') FROM numbers(1600)");

    const v2 = writeBuild("events-v2.json", [DB, EVENTS_V2, DAILY, DAILY_MV]);
    const plan = await planAgainstServer("e2e", join(dir, v2), { config: {}, env: { CLICKHOUSE_URL: server!.endpoint.url } });
    expect(plan.rebuilds.map((c) => c.rule)).toEqual(["SQLCH220"]);
    expect(plan.rebuildOps).toEqual([
      expect.objectContaining({ table: "shop.events", env: "e2e", dualWrite: { mode: "materialized-view", cutoverColumn: "ts" } }),
    ]);
    expect(plan.rebuildOps![0]!.declaration).toContain('ClickHouseRebuildOp({ name: "rebuild-shop-events", env: "e2e", table: "shop.events"');

    const refused = normalizeApply(toApplyResult(await clickhouseApply({ buildPath: join(dir, v2), environment: "e2e" }, undefined, deps())));
    expect(refused.notAttempted).toEqual([expect.objectContaining({ name: "shop.events", reason: "unsupported-kind" })]);
    expect(refused.notAttempted[0]!.detail).toContain('ClickHouseRebuildOp({ table: "shop.events"');
  }, 180_000);

  test("the first run fills the new table and stops at the swap gate with the verification attached", async () => {
    const r = await runOp(config(), ledger.port);
    expect(r.status).toBe("gated");
    expect(r.gate).toMatchObject({ gate: "approve-rebuild-events" });
    expect(r.gate!.planDigest).toMatch(/^jcs1-sha256:/);
    expect(outcome(r, "RebuildState")).toBe("rebuild");
    expect(outcome(r, "VerifiedRows")).toBe(1600);
    expect(outcome(r, "VerifiedPartitions")).toBe(4);
    expect(String(outcome(r, "Verification"))).toMatch(/4 partition\(s\), 1600 row\(s\) \(1600 of them before the cut-over/);
    expect(await count("shop.events__chant_new")).toBe(1600);
    expect(await exists("shop", "events__chant_dual")).toBe(true);
    // Nothing visible to a plan or an apply: the working objects are left out.
    const plan = await planAgainstServer("e2e", join(dir, "events-v2.json"), { config: {}, env: { CLICKHOUSE_URL: server!.endpoint.url } });
    expect(plan.changes.map((c) => c.rule)).toEqual(["SQLCH220"]);

    // Writes go on during the rebuild; the dual-write view carries them over.
    await q("INSERT INTO shop.events VALUES (now() + 3600, 7, 'click')");
    expect(await count("shop.events__chant_new")).toBe(1601);

    // Running again before anyone approves copies nothing again: the four
    // partitions are skipped by their receipts. The row just written opened a
    // fifth partition, whose copy is empty (its rows are after the cut-over,
    // the dual-write view's), and the verification and the plan it binds are
    // unchanged, so the gate stands as it was.
    const again = await runOp(config(), ledger.port);
    expect(again.status).toBe("gated");
    expect(outcome(again, "Skipped")).toBe(4);
    expect(outcome(again, "Copied")).toBe(1);
    expect(again.gate!.planDigest).toBe(r.gate!.planDigest);
    expect(await count("shop.events__chant_new")).toBe(1601);
  }, 300_000);

  test("approved, it swaps, recreates the view that reads the table and stops at the drop gate", async () => {
    ledger.approveLast();
    const r = await runOp(config(), ledger.port);
    expect(r.status).toBe("gated");
    expect(r.gate).toMatchObject({ gate: "approve-rebuild-events-drop" });
    expect(outcome(r, "Dependents")).toEqual(["shop.daily_mv"]);

    expect(await showCreate("shop.events")).toMatch(/ORDER BY \(user_id, ts\)/);
    expect(await count("shop.events")).toBe(1601);
    expect(await exists("shop", "events__chant_dual")).toBe(false);
    expect(await exists("shop", "events__chant_new")).toBe(false);
    expect(await count("shop.events__chant_old")).toBe(1601);
    const [{ comment }] = await q<{ comment: string }>("SELECT comment FROM system.tables WHERE database = 'shop' AND name = 'events'");
    expect(comment).toBe("Raw events [chant managed-by=chant stack=e2e env=test]");

    // The materialized view reads the new table.
    const before = Number((await q<{ n: string }>("SELECT sum(n) AS n FROM shop.daily"))[0]!.n);
    await q("INSERT INTO shop.events VALUES (now(), 8, 'view')");
    expect(Number((await q<{ n: string }>("SELECT sum(n) AS n FROM shop.daily"))[0]!.n)).toBe(before + 1);
  }, 300_000);

  test("approved again, it drops the old table, and the server holds the declaration", async () => {
    ledger.approveLast();
    const r = await runOp(config(), ledger.port);
    expect(r.status).toBe("ok");
    expect(outcome(r, "Dropped")).toBe(true);
    expect(await exists("shop", "events__chant_old")).toBe(false);
    const plan = await planAgainstServer("e2e", join(dir, "events-v2.json"), { config: {}, env: { CLICKHOUSE_URL: server!.endpoint.url } });
    expect(plan.changes).toEqual([]);

    // A run after it is done finds nothing to do.
    const done = await runOp(config(), ledger.port);
    expect(done.status).toBe("ok");
    expect(outcome(done, "RebuildState")).toBe("done");
  }, 300_000);
});

describe.skipIf(!enabled)("rows dated after the cut-over that the table already held (sql-yodeler#45)", () => {
  const bookingsDdl = (orderBy: string) => `CREATE TABLE shop.bookings
(
  id UInt64,
  kind LowCardinality(String),
  at DateTime
)
ENGINE = MergeTree
PARTITION BY toYYYYMM(at)
ORDER BY ${orderBy}`;
  const V1: Obj = { export: "bookings", type: "ClickHouse::Table", dependsOn: ["shop"], ddl: bookingsDdl("(kind, at)") };
  const V2: Obj = { ...V1, ddl: bookingsDdl("(kind, id)") };
  const config = (): ClickHouseRebuildOpConfig => ({
    name: "rebuild-bookings",
    env: "e2e",
    table: "shop.bookings",
    dualWrite: { mode: "materialized-view", cutoverColumn: "at", cutoverDelay: "2s" },
    build: false,
    path: dir,
    output: "bookings-v2.json",
    retain: "0s",
    stack: MARKER.stack,
    ownershipEnv: MARKER.env,
  });

  test("every row is copied and compared, those written during the rebuild too, and the swap leaves none behind", async () => {
    await clickhouseApply({ buildPath: join(dir, writeBuild("bookings-v1.json", [DB, V1])), environment: "e2e" }, undefined, deps());
    // 600 rows seven hours apart, from four months ago to about two months
    // ahead, with an identical pair among the future ones.
    await q(
      "INSERT INTO shop.bookings SELECT number, ['view','cart','buy'][number % 3 + 1], toStartOfHour(now()) - toIntervalDay(120) + toIntervalHour(number * 7) FROM numbers(600)",
    );
    await q("INSERT INTO shop.bookings VALUES (599, 'buy', toStartOfHour(now()) - toIntervalDay(120) + toIntervalHour(599 * 7))");
    const future = Number((await q<{ n: string }>("SELECT count() AS n FROM shop.bookings WHERE at > now() + 60"))[0]!.n);
    expect(future).toBeGreaterThan(150);
    writeBuild("bookings-v2.json", [DB, V2]);

    const ledger = new Ledger();
    const first = await runOp(config(), ledger.port);
    expect(first.status).toBe("gated");
    expect(first.gate).toMatchObject({ gate: "approve-rebuild-bookings" });
    expect(outcome(first, "VerifiedRows")).toBe(601);
    expect(await count("shop.bookings__chant_new")).toBe(601);

    // Written during the rebuild, after the cut-over: through the view.
    await q("INSERT INTO shop.bookings VALUES (1000, 'buy', now() + toIntervalDay(40)), (1001, 'cart', now())");
    const again = await runOp(config(), ledger.port);
    expect(again.status).toBe("gated");
    expect(outcome(again, "VerifiedRows")).toBe(603);
    // The rows before the cut-over are what the approval binds; later rows do not change it.
    expect(again.gate!.planDigest).toBe(first.gate!.planDigest);

    ledger.approveLast();
    await q("INSERT INTO shop.bookings VALUES (1002, 'view', now() + toIntervalDay(70))");
    const swapped = await runOp(config(), ledger.port);
    expect(swapped.status).toBe("gated");
    expect(swapped.gate).toMatchObject({ gate: "approve-rebuild-bookings-drop" });
    expect(await showCreate("shop.bookings")).toMatch(/ORDER BY \(kind, id\)/);
    expect(await count("shop.bookings")).toBe(604);
    expect(await count("shop.bookings__chant_old")).toBe(604);
    const diff = await q("SELECT * FROM shop.bookings__chant_old EXCEPT ALL SELECT * FROM shop.bookings");
    expect(diff).toEqual([]);
  }, 300_000);

  test("a row that reaches the old table alone after the verification stops the swap", async () => {
    const clicksDdl = (orderBy: string) => `CREATE TABLE shop.visits
(
  id UInt64,
  at DateTime
)
ENGINE = MergeTree
PARTITION BY toYYYYMM(at)
ORDER BY ${orderBy}`;
    const W1: Obj = { export: "visits", type: "ClickHouse::Table", dependsOn: ["shop"], ddl: clicksDdl("at") };
    const W2: Obj = { ...W1, ddl: clicksDdl("(id, at)") };
    await clickhouseApply({ buildPath: join(dir, writeBuild("visits-v1.json", [DB, W1])), environment: "e2e" }, undefined, deps());
    await q("INSERT INTO shop.visits SELECT number, now() - toIntervalDay(number % 90) FROM numbers(300)");
    writeBuild("visits-v2.json", [DB, W2]);
    const args = {
      table: "shop.visits",
      buildPath: "visits-v2.json",
      environment: "e2e",
      dualWrite: { mode: "materialized-view" as const, cutoverColumn: "at", cutoverDelay: "2s" },
      stack: MARKER.stack,
      ownershipEnv: MARKER.env,
      cwd: dir,
    };
    await rebuildActivities.clickhouseRebuildCreate(args, undefined, deps());
    await rebuildActivities.clickhouseRebuildDualWrite(args, undefined, deps());
    await rebuildActivities.clickhouseRebuildBackfill(args, undefined, deps());
    expect(await rebuildActivities.clickhouseRebuildVerify(args, undefined, deps())).toMatchObject({ rows: 300 });

    // Late: a time well before the cut-over, written after the verification.
    await q("INSERT INTO shop.visits VALUES (9999, now() - toIntervalDay(30))");
    await expect(rebuildActivities.clickhouseRebuildSwap(args, undefined, deps())).rejects.toThrow(/does not match the old one in 1 partition/);
    expect(await showCreate("shop.visits")).toMatch(/ORDER BY at/);
    expect(await count("shop.visits")).toBe(301);
    expect(await count("shop.visits__chant_new")).toBe(300);
    await rebuildActivities.clickhouseRebuildCompensate(args, undefined, deps());
  }, 300_000);
});

describe.skipIf(!enabled)("a failure runs onFailure, which drops the new table", () => {
  const clicksDdl = (orderBy: string) => `CREATE TABLE shop.clicks (id UInt64, url String) ENGINE = MergeTree ORDER BY ${orderBy}`;
  const V1: Obj = { export: "clicks", type: "ClickHouse::Table", dependsOn: ["shop"], ddl: clicksDdl("id") };
  const V2: Obj = { ...V1, ddl: clicksDdl("(url, id)") };
  const config = (): ClickHouseRebuildOpConfig => ({
    name: "rebuild-clicks",
    env: "e2e",
    table: "shop.clicks",
    dualWrite: { mode: "app" },
    build: false,
    path: dir,
    output: "clicks-v2.json",
    stack: MARKER.stack,
    ownershipEnv: MARKER.env,
  });

  test("rows written after the backfill fail the verification and the new table is dropped", async () => {
    await clickhouseApply({ buildPath: join(dir, writeBuild("clicks-v1.json", [DB, V1])), environment: "e2e" }, undefined, deps());
    await q("INSERT INTO shop.clicks SELECT number, concat('/p/', toString(number % 7)) FROM numbers(500)");
    writeBuild("clicks-v2.json", [DB, V2]);

    const ledger = new Ledger();
    const first = await runOp(config(), ledger.port);
    expect(first.status).toBe("gated");
    expect(first.gate).toMatchObject({ gate: "rebuild-clicks-writes-stopped" });
    expect(await exists("shop", "clicks__chant_new")).toBe(true);

    ledger.approveLast();
    const second = await runOp(config(), ledger.port);
    expect(second.status).toBe("gated");
    expect(second.gate).toMatchObject({ gate: "approve-rebuild-clicks" });
    expect(await count("shop.clicks__chant_new")).toBe(500);

    // The application did not stop writing after all.
    await q("INSERT INTO shop.clicks VALUES (9999, '/late')");
    const failure = await runOp(config(), ledger.port).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(failure).toBeInstanceOf(OpRunFailure);
    const records = (failure as OpRunFailure).result.records;
    expect(records.find((x) => x.fn === "clickhouseRebuildVerify")?.error).toMatch(/does not match the old one in 1 partition/);
    expect(records.find((x) => x.fn === "clickhouseRebuildCompensate")?.status).toBe("ok");
    expect(await exists("shop", "clicks__chant_new")).toBe(false);
    expect(await count("shop.clicks")).toBe(501);
    expect(await showCreate("shop.clicks")).toMatch(/ORDER BY id/);
  }, 300_000);
});

describe.skipIf(!enabled)("an interrupted backfill resumes from its receipts", () => {
  const viewsDdl = (orderBy: string) => `CREATE TABLE shop.page_views (day Date, page String, n UInt32) ENGINE = MergeTree PARTITION BY day ORDER BY ${orderBy}`;
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

  test("stopped after three partitions, killed before a receipt, then resumed: every row once", async () => {
    await clickhouseApply({ buildPath: join(dir, writeBuild("views-v1.json", [DB, V1])), environment: "e2e" }, undefined, deps());
    await q("INSERT INTO shop.page_views SELECT toDate('2026-03-01') + number % 6, concat('/p/', toString(number % 11)), number FROM numbers(6000)");
    writeBuild("views-v2.json", [DB, V2]);
    await rebuildActivities.clickhouseRebuildCreate(args(), undefined, deps());

    // Interrupted (Ctrl-C) after the third partition.
    const stop = new AbortController();
    let done = 0;
    const interrupted = await rebuildActivities
      .clickhouseRebuildBackfill(args(), stop.signal, { ...deps(), backfill: { afterPartition: () => void (++done === 3 && stop.abort()) } })
      .then(
        () => undefined,
        (e: unknown) => e,
      );
    expect(interrupted).toBeDefined();
    expect(await count("shop.page_views__chant_new")).toBe(3000);

    // Killed between the fourth partition's INSERT and its receipt.
    const real = clickhouseReceiptStore(server!.endpoint, MARKER);
    let writes = 0;
    const crashing: ClickHouseReceiptStore = {
      ...real,
      read: real.read,
      readAll: real.readAll,
      write: async (receipt, expectation) => {
        if (++writes === 1) throw new Error("killed before the receipt");
        return real.write(receipt, expectation);
      },
    };
    await expect(rebuildActivities.clickhouseRebuildBackfill(args(), undefined, { ...deps(), backfill: { receipts: crashing } })).rejects.toThrow(/killed before the receipt/);
    expect(await count("shop.page_views__chant_new")).toBe(4000);

    // Resumed: three partitions skipped by receipt, the fourth cleared and copied again, two more copied.
    const resumed = await rebuildActivities.clickhouseRebuildBackfill(args(), undefined, deps());
    expect(resumed).toMatchObject({ partitions: 6, skipped: 3, copied: 3, cleared: 1 });
    expect(await count("shop.page_views__chant_new")).toBe(6000);

    const verified = await rebuildActivities.clickhouseRebuildVerify(args(), undefined, deps());
    expect(verified).toMatchObject({ partitions: 6, rows: 6000 });
    const receipts = await q<{ address: string }>(`SELECT DISTINCT address FROM ${RECEIPTS_DATABASE}.${RECEIPTS_TABLE} WHERE address LIKE 'e2e/test/rebuild/shop.page_views/%' ORDER BY address`);
    expect(receipts).toHaveLength(6);

    // The receipts database is chant's own bookkeeping, not a declared schema.
    const plan = await planAgainstServer("e2e", join(dir, "views-v2.json"), { config: {}, env: { CLICKHOUSE_URL: server!.endpoint.url } });
    expect(plan.changes.map((c) => c.object)).not.toContain(RECEIPTS_DATABASE);

    const dropped = await rebuildActivities.clickhouseRebuildCompensate(args(), undefined, deps());
    expect(dropped.dropped).toEqual(["shop.page_views__chant_new"]);
  }, 300_000);
});

describe.skipIf(!enabled)("under an outer approval, a failed rebuild keeps its new table and the rerun resumes (#3658)", () => {
  const sessionsDdl = (orderBy: string) => `CREATE TABLE shop.sessions
(
  day Date,
  user_id UInt64,
  ts DateTime
)
ENGINE = MergeTree
PARTITION BY day
ORDER BY ${orderBy}`;
  const V1: Obj = { export: "sessions", type: "ClickHouse::Table", dependsOn: ["shop"], ddl: sessionsDdl("(day, user_id)") };
  const V2: Obj = { ...V1, ddl: sessionsDdl("(user_id, day)") };
  const config = (): ClickHouseRebuildOpConfig => ({
    name: "rebuild-sessions",
    env: "e2e",
    table: "shop.sessions",
    dualWrite: { mode: "materialized-view", cutoverColumn: "ts", cutoverDelay: "2s" },
    build: false,
    path: dir,
    output: "sessions-v2.json",
    stack: MARKER.stack,
    ownershipEnv: MARKER.env,
    gates: "outer",
    onFailure: "keep",
  });
  const receipts = async () =>
    (await q<{ address: string }>(`SELECT DISTINCT address FROM ${RECEIPTS_DATABASE}.${RECEIPTS_TABLE} WHERE address LIKE 'e2e/test/rebuild/shop.sessions/%'`)).length;

  test("the failed run keeps the new table and its receipts; the rerun skips what was copied, swaps without a gate and keeps the old table", async () => {
    await clickhouseApply({ buildPath: join(dir, writeBuild("sessions-v1.json", [DB, V1])), environment: "e2e" }, undefined, deps());
    // Six days of rows, a partition each, all well before any cut-over.
    await q("INSERT INTO shop.sessions SELECT toDate('2026-02-01') + number % 6, number, toDateTime('2026-02-01 00:00:00') + (number % 6) * 86400 FROM numbers(1200)");
    writeBuild("sessions-v2.json", [DB, V2]);

    // Every attempt of the backfill step fails after its partition: three attempts, three partitions copied, then the run fails.
    let copied = 0;
    const ledger = new Ledger();
    const failure = await runOp(config(), ledger.port, {
      backfill: {
        afterPartition: () => {
          copied++;
          throw new Error(`the backfill failed after ${copied} partition(s)`);
        },
      },
    }).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(failure).toBeInstanceOf(OpRunFailure);
    const records = (failure as OpRunFailure).result.records;
    expect(records.find((x) => x.fn === "clickhouseRebuildBackfill")?.error).toMatch(/the backfill failed after 3 partition/);
    // No onFailure ran: the new table, the dual-write view and the receipts are there.
    expect(records.find((x) => x.fn === "clickhouseRebuildCompensate")).toBeUndefined();
    expect(await exists("shop", "sessions__chant_new")).toBe(true);
    expect(await exists("shop", "sessions__chant_dual")).toBe(true);
    expect(await count("shop.sessions__chant_new")).toBe(600);
    expect(await receipts()).toBe(3);
    expect(await showCreate("shop.sessions")).toMatch(/ORDER BY \(day, user_id\)/);

    // The rerun resumes: three partitions skipped by receipt, three copied, verified, swapped, with no gate.
    const r = await runOp(config(), ledger.port);
    expect(r.status).toBe("ok");
    expect(ledger.port.appended).toEqual([]);
    expect(outcome(r, "Skipped")).toBe(3);
    expect(outcome(r, "Copied")).toBe(3);
    expect(outcome(r, "VerifiedRows")).toBe(1200);
    expect(r.records.map((x) => x.fn)).not.toContain("clickhouseRebuildDrop");
    expect(await showCreate("shop.sessions")).toMatch(/ORDER BY \(user_id, day\)/);
    expect(await count("shop.sessions")).toBe(1200);
    // The old table is kept: dropping it is a run with the Op's own gates.
    expect(await count("shop.sessions__chant_old")).toBe(1200);
    expect(await exists("shop", "sessions__chant_new")).toBe(false);
    expect(await receipts()).toBe(6);

    // Run with its own gates, the Op has nothing left to swap, and its drop gate binds that old table.
    const ownLedger = new Ledger();
    const own = await runOp({ ...config(), gates: "own" }, ownLedger.port);
    expect(own.status).toBe("gated");
    expect(own.gate).toMatchObject({ gate: "approve-rebuild-sessions" });
    expect(outcome(own, "RebuildState")).toBe("swapped");
    ownLedger.approveLast();
    const drop = await runOp({ ...config(), gates: "own" }, ownLedger.port);
    expect(drop.status).toBe("gated");
    expect(drop.gate).toMatchObject({ gate: "approve-rebuild-sessions-drop" });
    expect(await count("shop.sessions__chant_old")).toBe(1200);
  }, 300_000);

  test('a refusal says to drop the kept table by hand', async () => {
    // A new table made from another declaration: refused, and nothing will drop it.
    writeBuild("sessions-v3.json", [DB, { ...V1, ddl: sessionsDdl("(ts, user_id)") }]);
    await q("CREATE TABLE shop.sessions__chant_new AS shop.sessions");
    await q(`ALTER TABLE shop.sessions__chant_new MODIFY COMMENT 'x [chant managed-by=chant stack=e2e env=test rebuild=shop.sessions role=new]'`);
    const args = { table: "shop.sessions", buildPath: "sessions-v3.json", environment: "e2e", dualWrite: { mode: "app" as const }, stack: MARKER.stack, ownershipEnv: MARKER.env, cwd: dir };
    await expect(rebuildActivities.clickhouseRebuildCreate({ ...args, keepOnFailure: true }, undefined, deps())).rejects.toThrow(
      /keeps its new table on failure \(onFailure: "keep"\), so nothing drops it: drop shop\.sessions__chant_new/,
    );
    await expect(rebuildActivities.clickhouseRebuildCreate(args, undefined, deps())).rejects.not.toThrow(/onFailure: "keep"/);
    await q("DROP TABLE shop.sessions__chant_new SYNC");
  }, 300_000);
});
