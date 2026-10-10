/**
 * A plain MergeTree rebuilt into a SummingMergeTree (#3727).
 *
 * The old table keeps every row it was given; the new one keeps one row per
 * sorting key, its sums, and drops a key whose sums are all zero. So the row
 * counts differ by design. The Verify phase groups both tables by the new
 * sorting key and compares each key's sums, finds them equal, and the run
 * swaps once approved. A key the new table lost, or a sum it changed, still
 * fails the verification.
 *
 * Runs against `CHANT_SQL_E2E_CLICKHOUSE_URL` when it is set (a shared
 * server: everything is in the databases `chant_e2e_3727` and
 * `chant_e2e_3727_loss`, dropped afterwards, with this test's receipts),
 * otherwise a scratch server, which needs Docker and skips cleanly without it.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { memoryGateLedgerPort, runOpLocally, loadProfiles, type ActivityFn, type GateLedgerPort, type OpConfig } from "@intentius/chant/op";
import { dockerAvailable, startScratchServer, type ScratchServer } from "../container";
import { clickhouseQuery, type ClickHouseEndpoint } from "../http";
import { clickhouseImage } from "../../spec/pin";
import { clickhouseApply } from "../../op/activities/clickhouse-apply";
import * as rebuildActivities from "../../op/activities/clickhouse-rebuild";
import { ClickHouseRebuildOp } from "./op";
import { RECEIPTS_DATABASE, RECEIPTS_TABLE } from "./receipts";

const given = process.env.CHANT_SQL_E2E_CLICKHOUSE_URL;
const enabled = given ? true : await dockerAvailable();
const DATABASES = ["chant_e2e_3727", "chant_e2e_3727_loss"];
const MARKER = { stack: "chant_e2e_3727", env: "test" };
let server: ScratchServer | undefined;
let endpoint: ClickHouseEndpoint;
const dir = mkdtempSync(join(tmpdir(), "chant-sql-rebuild-into-collapsing-"));

const q = <T = Record<string, unknown>>(sql: string) => clickhouseQuery<T>(endpoint, sql);
const count = async (from: string) => Number((await q<{ n: string }>(`SELECT count() AS n FROM ${from}`))[0]!.n);
const mutate = (sql: string) => clickhouseQuery(endpoint, sql, { settings: { mutations_sync: "2" } });

async function cleanup(): Promise<void> {
  for (const db of DATABASES) await q(`DROP DATABASE IF EXISTS ${db} SYNC`);
  const receipts = await q<{ n: string }>(`SELECT count() AS n FROM system.tables WHERE database = '${RECEIPTS_DATABASE}' AND name = '${RECEIPTS_TABLE}'`);
  if (Number(receipts[0]!.n) > 0) await mutate(`ALTER TABLE ${RECEIPTS_DATABASE}.${RECEIPTS_TABLE} DELETE WHERE position(address, '${MARKER.stack}') > 0`);
}

beforeAll(async () => {
  if (!enabled) return;
  if (given) endpoint = { url: given, user: "default", password: process.env.CHANT_SQL_E2E_CLICKHOUSE_PASSWORD ?? "" };
  else {
    server = await startScratchServer(clickhouseImage(), { namePrefix: "chant-sql-rebuild-into-collapsing" });
    endpoint = server.endpoint;
  }
  await cleanup();
}, 600_000);

afterAll(async () => {
  if (enabled) await cleanup().catch(() => undefined);
  await server?.stop();
  rmSync(dir, { recursive: true, force: true });
});

const deps = () => ({ config: { ownership: MARKER }, env: { CLICKHOUSE_URL: endpoint.url, CLICKHOUSE_USER: endpoint.user, CLICKHOUSE_PASSWORD: endpoint.password }, log: () => undefined });

function writeBuild(db: string, file: string, engine: string): string {
  const objects = [
    { export: "db", type: "ClickHouse::Database", ddl: `CREATE DATABASE ${db} ENGINE = Atomic`, dependsOn: [] },
    {
      export: "daily",
      type: "ClickHouse::Table",
      dependsOn: ["db"],
      ddl: `CREATE TABLE ${db}.daily (day Date, shop UInt32, total Decimal(18, 2), n UInt64) ENGINE = ${engine} PARTITION BY toYYYYMM(day) ORDER BY (day, shop)`,
    },
  ];
  writeFileSync(join(dir, file), JSON.stringify({ dialect: "clickhouse", applyOrder: objects.map((o) => o.export), objects }));
  return join(dir, file);
}

/** Eleven rows: shop 1 three times and shop 2 twice on one day, shop 3 whose rows sum to zero, and six single rows across two months. */
async function seed(db: string): Promise<void> {
  await q(
    `INSERT INTO ${db}.daily VALUES ` +
      `('2026-09-01', 1, 10, 1), ('2026-09-01', 1, 20, 1), ('2026-09-01', 1, 30, 1), ('2026-09-01', 2, 5, 1), ('2026-09-01', 2, 7, 2), ` +
      `('2026-09-01', 3, 4, 0), ('2026-09-01', 3, -4, 0), ` +
      `('2026-09-02', 1, 1, 1), ('2026-09-03', 1, 2, 1), ('2026-10-01', 1, 3, 1), ('2026-10-02', 2, 4, 1)`,
  );
}

const activities = (): Map<string, ActivityFn> => {
  const out = new Map<string, ActivityFn>();
  for (const [name, fn] of Object.entries(rebuildActivities)) {
    if (typeof fn !== "function" || !name.startsWith("clickhouseRebuild")) continue;
    out.set(name, ((args: Record<string, unknown>, signal?: AbortSignal) => (fn as (a: unknown, s?: AbortSignal, d?: unknown) => Promise<unknown>)(args, signal, deps())) as ActivityFn);
  }
  return out;
};

/** An in-memory gate ledger: each approval answers the gate the last run stopped at, for the plan it recorded. */
class Ledger {
  private pending: unknown[] = [];
  private resolutions: unknown[] = [];
  port: GateLedgerPort = memoryGateLedgerPort();

  approveLast(): void {
    const last = (this.port as ReturnType<typeof memoryGateLedgerPort>).appended.at(-1)!;
    this.pending.push(...(this.port as ReturnType<typeof memoryGateLedgerPort>).appended);
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

describe.skipIf(!enabled)("a MergeTree rebuilt into a SummingMergeTree", () => {
  const DB = "chant_e2e_3727";
  test("the Verify phase compares each sorting key's sums, and the run swaps once approved", async () => {
    await clickhouseApply({ buildPath: writeBuild(DB, "daily-v1.json", "MergeTree"), environment: "e2e" }, undefined, deps());
    await seed(DB);
    writeBuild(DB, "daily-v2.json", "SummingMergeTree");

    const { op } = ClickHouseRebuildOp({
      name: "rebuild-daily-3727",
      env: "e2e",
      table: `${DB}.daily`,
      dualWrite: { mode: "materialized-view", cutoverColumn: "day", cutoverDelay: "1s" },
      build: false,
      path: dir,
      output: "daily-v2.json",
      stack: MARKER.stack,
      ownershipEnv: MARKER.env,
    });
    const props = (op as unknown as { props: OpConfig }).props;
    const ledger = new Ledger();
    const run = async () => runOpLocally(props, activities(), await loadProfiles(), undefined, { gates: ledger.port, now: new Date().toISOString() });

    const first = await run();
    expect(first.records.find((x) => x.fn === "clickhouseRebuildVerify")?.error).toBeUndefined();
    expect(first.status).toBe("gated");
    expect(first.gate).toMatchObject({ gate: "approve-rebuild-daily-3727" });
    const verification = first.records.flatMap((x) => x.outcomes ?? []).find((o) => o.name === "Verification")?.value;
    expect(String(verification)).toMatch(/2 partition\(s\), 11 row\(s\) of the old table as 6 key\(s\).*grouped by the sorting key of the new SummingMergeTree and compared on the sums of total, n/);

    ledger.approveLast();
    const swapped = await run();
    expect(swapped.records.find((x) => x.fn === "clickhouseRebuildSwap")?.status).toBe("ok");
    expect(swapped.gate).toMatchObject({ gate: "approve-rebuild-daily-3727-drop" });
    expect(await q<{ engine: string }>(`SELECT engine FROM system.tables WHERE database = '${DB}' AND name = 'daily'`)).toEqual([{ engine: "SummingMergeTree" }]);
    expect(await q(`SELECT toString(day) AS day, shop, toString(total) AS total, toString(n) AS n FROM ${DB}.daily FINAL WHERE day = '2026-09-01' ORDER BY shop`)).toEqual([
      { day: "2026-09-01", shop: 1, total: "60", n: "3" },
      { day: "2026-09-01", shop: 2, total: "12", n: "3" },
    ]);
  }, 300_000);
});

describe.skipIf(!enabled)("a MergeTree rebuilt into a SummingMergeTree that lost rows", () => {
  const DB = "chant_e2e_3727_loss";
  const args = {
    table: `${DB}.daily`,
    buildPath: "loss-v2.json",
    environment: "e2e",
    dualWrite: { mode: "materialized-view" as const, cutoverColumn: "day", cutoverDelay: "1s" },
    stack: MARKER.stack,
    ownershipEnv: MARKER.env,
    cwd: dir,
  };

  test("a changed sum, or a key missing from the new table, fails the verification and nothing is swapped", async () => {
    await clickhouseApply({ buildPath: writeBuild(DB, "loss-v1.json", "MergeTree"), environment: "e2e" }, undefined, deps());
    await seed(DB);
    writeBuild(DB, "loss-v2.json", "SummingMergeTree");
    await rebuildActivities.clickhouseRebuildCreate(args, undefined, deps());
    await rebuildActivities.clickhouseRebuildDualWrite(args, undefined, deps());
    await rebuildActivities.clickhouseRebuildBackfill(args, undefined, deps());
    expect(await rebuildActivities.clickhouseRebuildVerify(args, undefined, deps())).toMatchObject({ rows: 11, partitions: 2 });

    // A sum the copy got wrong.
    await mutate(`ALTER TABLE ${DB}.daily__chant_new UPDATE total = total + 1 WHERE shop = 2 AND day = '2026-09-01'`);
    await expect(rebuildActivities.clickhouseRebuildVerify(args, undefined, deps())).rejects.toThrow(
      /does not match the old one in 1 partition\(s\): \(?202609\)?: old 4 keys.*new 4 keys.*compared per key on the sums of total, n/,
    );
    await mutate(`ALTER TABLE ${DB}.daily__chant_new UPDATE total = total - 1 WHERE shop = 2 AND day = '2026-09-01'`);
    expect(await rebuildActivities.clickhouseRebuildVerify(args, undefined, deps())).toMatchObject({ rows: 11 });

    // A key the copy lost: the swap compares again before the EXCHANGE and stops.
    await mutate(`ALTER TABLE ${DB}.daily__chant_new DELETE WHERE shop = 1 AND day = '2026-10-01'`);
    await expect(rebuildActivities.clickhouseRebuildSwap(args, undefined, deps())).rejects.toThrow(/does not match the old one in 1 partition\(s\): \(?202610\)?: old 2 keys.*new 1 keys/);
    expect(await q<{ engine: string }>(`SELECT engine FROM system.tables WHERE database = '${DB}' AND name = 'daily'`)).toEqual([{ engine: "MergeTree" }]);
    expect(await count(`${DB}.daily`)).toBe(11);
    await rebuildActivities.clickhouseRebuildCompensate(args, undefined, deps());
  }, 300_000);
});
