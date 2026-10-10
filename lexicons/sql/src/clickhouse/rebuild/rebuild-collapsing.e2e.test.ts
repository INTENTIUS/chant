/**
 * A rebuild of a SummingMergeTree with unmerged parts (#3674).
 *
 * Three rows for one key, in three parts the server is kept from merging.
 * The copy inserts them in one block, which the new table collapses into one
 * row as it writes it, so the raw counts differ (3 and 1) although the data
 * is the same. The Verify phase reads both tables under FINAL, finds them
 * equal, and the run reaches the swap gate.
 *
 * Runs against `CHANT_SQL_E2E_CLICKHOUSE_URL` when it is set (a shared
 * server: everything is in the database `chant_e2e_3674`, dropped
 * afterwards, with this test's receipts), otherwise a scratch server, which
 * needs Docker and skips cleanly without it.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { memoryGateLedgerPort, runOpLocally, loadProfiles, type ActivityFn, type OpConfig } from "@intentius/chant/op";
import { dockerAvailable, startScratchServer, type ScratchServer } from "../container";
import { clickhouseQuery, type ClickHouseEndpoint } from "../http";
import { clickhouseImage } from "../../spec/pin";
import { clickhouseApply } from "../../op/activities/clickhouse-apply";
import * as rebuildActivities from "../../op/activities/clickhouse-rebuild";
import { ClickHouseRebuildOp } from "./op";
import { RECEIPTS_DATABASE, RECEIPTS_TABLE } from "./receipts";

const given = process.env.CHANT_SQL_E2E_CLICKHOUSE_URL;
const enabled = given ? true : await dockerAvailable();
const DB = "chant_e2e_3674";
const MARKER = { stack: "chant_e2e_3674", env: "test" };
let server: ScratchServer | undefined;
let endpoint: ClickHouseEndpoint;
const dir = mkdtempSync(join(tmpdir(), "chant-sql-rebuild-collapsing-"));

const q = <T = Record<string, unknown>>(sql: string) => clickhouseQuery<T>(endpoint, sql);
const count = async (from: string) => Number((await q<{ n: string }>(`SELECT count() AS n FROM ${from}`))[0]!.n);

async function cleanup(): Promise<void> {
  await q(`DROP DATABASE IF EXISTS ${DB} SYNC`);
  const receipts = await q<{ n: string }>(`SELECT count() AS n FROM system.tables WHERE database = '${RECEIPTS_DATABASE}' AND name = '${RECEIPTS_TABLE}'`);
  if (Number(receipts[0]!.n) > 0) {
    await clickhouseQuery(endpoint, `ALTER TABLE ${RECEIPTS_DATABASE}.${RECEIPTS_TABLE} DELETE WHERE position(address, '${MARKER.stack}') > 0`, { settings: { mutations_sync: "2" } });
  }
}

beforeAll(async () => {
  if (!enabled) return;
  if (given) endpoint = { url: given, user: "default", password: process.env.CHANT_SQL_E2E_CLICKHOUSE_PASSWORD ?? "" };
  else {
    server = await startScratchServer(clickhouseImage(), { namePrefix: "chant-sql-rebuild-collapsing" });
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

function writeBuild(file: string, orderBy: string): string {
  const objects = [
    { export: "db", type: "ClickHouse::Database", ddl: `CREATE DATABASE ${DB} ENGINE = Atomic`, dependsOn: [] },
    {
      export: "daily",
      type: "ClickHouse::Table",
      dependsOn: ["db"],
      ddl: `CREATE TABLE ${DB}.daily (day Date, total Decimal(18, 2), n UInt64 DEFAULT 0) ENGINE = SummingMergeTree ORDER BY ${orderBy}`,
    },
  ];
  writeFileSync(join(dir, file), JSON.stringify({ dialect: "clickhouse", applyOrder: objects.map((o) => o.export), objects }));
  return join(dir, file);
}

describe.skipIf(!enabled)("a SummingMergeTree with unmerged parts, rebuilt with a new sorting key", () => {
  test("the Verify phase compares the tables under FINAL and the run reaches the swap gate", async () => {
    await clickhouseApply({ buildPath: writeBuild("daily-v1.json", "day"), environment: "e2e" }, undefined, deps());
    await q(`SYSTEM STOP MERGES ${DB}.daily`);
    for (const total of [30, 30, 40]) await q(`INSERT INTO ${DB}.daily VALUES ('2026-10-10', ${total}, 0)`);
    expect(await count(`${DB}.daily`)).toBe(3);
    writeBuild("daily-v2.json", "(day, n)");

    const { op } = ClickHouseRebuildOp({
      name: "rebuild-daily",
      env: "e2e",
      table: `${DB}.daily`,
      dualWrite: { mode: "materialized-view", cutoverColumn: "day", cutoverDelay: "1s" },
      build: false,
      path: dir,
      output: "daily-v2.json",
      stack: MARKER.stack,
      ownershipEnv: MARKER.env,
    });
    const activities = new Map<string, ActivityFn>();
    for (const [name, fn] of Object.entries(rebuildActivities)) {
      if (typeof fn !== "function" || !name.startsWith("clickhouseRebuild")) continue;
      activities.set(name, ((args: Record<string, unknown>, signal?: AbortSignal) =>
        (fn as (a: unknown, s?: AbortSignal, d?: unknown) => Promise<unknown>)(args, signal, deps())) as ActivityFn);
    }
    const r = await runOpLocally((op as unknown as { props: OpConfig }).props, activities, await loadProfiles(), undefined, {
      gates: memoryGateLedgerPort(),
      now: new Date().toISOString(),
    });

    const verify = r.records.find((x) => x.fn === "clickhouseRebuildVerify");
    expect(verify?.error).toBeUndefined();
    expect(r.status).toBe("gated");
    expect(r.gate).toMatchObject({ gate: "approve-rebuild-daily" });
    const verification = r.records.flatMap((x) => x.outcomes ?? []).find((o) => o.name === "Verification")?.value;
    expect(String(verification)).toMatch(/1 row\(s\).*read under FINAL \(SummingMergeTree\)/);
    // The old table still holds its three unmerged rows; the new one holds them collapsed.
    expect(await count(`${DB}.daily`)).toBe(3);
    expect(await q(`SELECT toString(day) AS day, toString(total) AS total FROM ${DB}.daily__chant_new`)).toEqual([{ day: "2026-10-10", total: "100" }]);
  }, 300_000);
});
