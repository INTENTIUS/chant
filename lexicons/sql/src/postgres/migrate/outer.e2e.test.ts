/**
 * `PostgresMigrationOp` under an outer approval with what the expand added
 * kept on failure (#3687): a backfill that fails part way leaves the new
 * column, its dual write and its receipts; the next run skips the batches
 * already filled, verifies and switches with no gate, and keeps the old
 * column; a later run with the Op's own gates stops at its gates. A refusal
 * says how to start again, since nothing drops what was kept.
 *
 * The server: `CHANT_SQL_E2E_POSTGRES_URL` (a `postgres://user@host:port/db`
 * URL, with `CHANT_SQL_E2E_POSTGRES_PASSWORD`) names a running one, such as
 * the one `chant emulator up --lexicon sql` starts. Without it, a throwaway
 * server at the pin, skipped cleanly when Docker is not available. The test
 * writes only to the schema `chant_e2e_3687`, dropped afterwards.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { OpRunFailure } from "@intentius/chant/op";
import { dockerAvailable, startTestPostgres, type TestPostgres } from "../testing/server";
import { connectPostgres, type PostgresClient, type PostgresEndpoint } from "../live/client";
import { postgresApply } from "../../op/activities/postgres-apply";
import * as m from "../../op/activities/postgres-migration";
import type { PostgresMigrationArgs, PostgresMigrationOpConfig } from "./op";
import { ApprovingLedger, runMigrationOp, runOutcome } from "../testing/migration";
import { POSTGRES_RECEIPTS_TABLE } from "./receipts";

const S = "chant_e2e_3687";
const given = process.env.CHANT_SQL_E2E_POSTGRES_URL;
const enabled = given ? true : await dockerAvailable();
const dir = mkdtempSync(join(tmpdir(), "chant-pg-outer-"));
let server: TestPostgres | undefined;
let endpoint: PostgresEndpoint;
let admin: PostgresClient;

beforeAll(async () => {
  if (!enabled) return;
  if (given) endpoint = { url: given, password: process.env.CHANT_SQL_E2E_POSTGRES_PASSWORD ?? "" };
  else {
    server = await startTestPostgres();
    endpoint = server.endpoint();
  }
  admin = await connectPostgres(endpoint);
  await admin.query(`DROP SCHEMA IF EXISTS ${S} CASCADE`);
}, 600_000);

afterAll(async () => {
  if (enabled) {
    await admin?.query(`DROP SCHEMA IF EXISTS ${S} CASCADE`).catch(() => undefined);
    await admin?.end();
  }
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
  writeFileSync(join(dir, file), JSON.stringify({ dialect: "postgres", postgresMajor: 18, applyOrder: objects.map((o) => o.export), objects: objects.map((o) => ({ dependsOn: [], ...o })) }));
  return file;
}

const MARKER = { stack: "e2e3687", env: "test" };
const profile = () => ({
  config: { ownership: MARKER, sql: { profiles: { e2e: { url: endpoint.url, password: { env: "PG_E2E_PASSWORD" }, schemas: [S] } } } },
  env: { PG_E2E_PASSWORD: endpoint.password ?? "" },
});
const deps = (extra: Partial<m.PostgresMigrationDeps> = {}): m.PostgresMigrationDeps => ({ ...profile(), log: () => undefined, ...extra });
const apply = (file: string) => postgresApply({ buildPath: join(dir, file), environment: "e2e" }, undefined, { ...profile(), log: () => undefined });
const one = async <T>(sql: string): Promise<T> => (await admin.query<T>(sql))[0]!;
const columnsOf = async (table: string) =>
  (await admin.query<{ name: string }>(`SELECT attname AS name FROM pg_attribute WHERE attrelid = '${table}'::regclass AND attnum > 0 AND NOT attisdropped ORDER BY attnum`)).map((r) => r.name);
const receipts = async () => (await one<{ n: number }>(`SELECT count(*)::int AS n FROM ${S}.${POSTGRES_RECEIPTS_TABLE} WHERE address LIKE 'e2e3687/test/migrate/${S}.events.kind/%' AND address NOT LIKE '%/batches'`)).n;

describe.skipIf(!enabled)("under an outer approval, a failed migration keeps its new column and the rerun resumes (#3687)", () => {
  const SCHEMA: Obj = { export: "app", type: "Postgres::Schema", ddl: `CREATE SCHEMA ${S}` };
  const V1: Obj = { export: "events", type: "Postgres::Table", dependsOn: ["app"], ddl: `CREATE TABLE ${S}.events (id bigint PRIMARY KEY, kind varchar(20) NOT NULL)` };
  const V2: Obj = { ...V1, ddl: `CREATE TABLE ${S}.events (id bigint PRIMARY KEY, kind varchar(10) NOT NULL)` };
  const config = (): PostgresMigrationOpConfig => ({
    name: "migrate-events-kind",
    env: "e2e",
    table: `${S}.events`,
    column: "kind",
    build: false,
    path: dir,
    output: "events-v2.json",
    retain: "0s",
    batchSize: 100,
    stack: MARKER.stack,
    ownershipEnv: MARKER.env,
    gates: "outer",
    onFailure: "keep",
  });
  const args = (): PostgresMigrationArgs => ({ table: `${S}.events`, column: "kind", buildPath: "events-v2.json", environment: "e2e", batchSize: 100, stack: MARKER.stack, ownershipEnv: MARKER.env, cwd: dir });

  test("the failed run keeps the new column and its receipts; the rerun skips what was filled, switches without a gate and keeps the old column", async () => {
    await apply(writeBuild("events-v1.json", [SCHEMA, V1]));
    await admin.query(`INSERT INTO ${S}.events SELECT g, CASE WHEN g % 2 = 0 THEN 'click' ELSE 'view' END FROM generate_series(0, 599) g`);
    writeBuild("events-v2.json", [SCHEMA, V2]);

    // A refusal says how to start again when nothing drops what was kept; without keepOnFailure it does not.
    await expect(m.postgresMigrationBackfill({ ...args(), keepOnFailure: true }, undefined, deps())).rejects.toThrow(
      /the Expand phase adds it\. This migration keeps what the expand added on failure \(onFailure: "keep"\), so nothing drops it: to start again from a new column, run the Op once with onFailure: "drop"/,
    );
    await expect(m.postgresMigrationBackfill(args(), undefined, deps())).rejects.not.toThrow(/onFailure: "keep"/);

    // Every attempt of the backfill step fails after its batch: three attempts, three batches filled, then the run fails.
    let filled = 0;
    const ledger = new ApprovingLedger();
    const failure = await runMigrationOp(config(), ledger.port, () =>
      deps({
        backfill: {
          afterBatch: () => {
            filled++;
            throw new Error(`the backfill failed after ${filled} batch(es)`);
          },
        },
      }),
    ).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(failure).toBeInstanceOf(OpRunFailure);
    const records = (failure as OpRunFailure).result.records;
    expect(records.find((x) => x.fn === "postgresMigrationBackfill")?.error).toMatch(/the backfill failed after 3 batch/);
    // No onFailure ran: the new column, the dual write and the receipts are there.
    expect(records.find((x) => x.fn === "postgresMigrationCompensate")).toBeUndefined();
    expect(await columnsOf(`${S}.events`)).toEqual(["id", "kind", "kind__chant_new"]);
    expect(await one(`SELECT count(*)::int AS n FROM pg_trigger WHERE tgrelid = '${S}.events'::regclass AND tgname = 'kind__chant_sync'`)).toEqual({ n: 1 });
    expect(await one(`SELECT count(*)::int AS n FROM ${S}.events WHERE kind__chant_new IS NOT NULL`)).toEqual({ n: 300 });
    expect(await receipts()).toBe(3);

    // The rerun resumes: three batches skipped by receipt, three filled, verified and switched, with no gate.
    const r = await runMigrationOp(config(), ledger.port, () => deps());
    expect(r.status).toBe("ok");
    expect(ledger.port.appended).toEqual([]);
    expect(runOutcome(r, "Skipped")).toBe(3);
    expect(runOutcome(r, "Filled")).toBe(3);
    expect(runOutcome(r, "VerifiedRows")).toBe(600);
    expect(r.records.map((x) => x.fn)).not.toContain("postgresMigrationContract");
    expect(await one(`SELECT format_type(atttypid, atttypmod) AS t FROM pg_attribute WHERE attrelid = '${S}.events'::regclass AND attname = 'kind'`)).toEqual({ t: "character varying(10)" });
    // The old column is kept: dropping it is a run with the Op's own gates.
    expect(await columnsOf(`${S}.events`)).toEqual(["id", "kind__chant_old", "kind"]);

    // Run with its own gates, the Op has nothing left to switch, and its contract gate binds that old column.
    const own = new ApprovingLedger();
    const first = await runMigrationOp({ ...config(), gates: "own" }, own.port, () => deps());
    expect(first.status).toBe("gated");
    expect(first.gate).toMatchObject({ gate: "approve-migrate-events-kind" });
    expect(runOutcome(first, "MigrationState")).toBe("switched");
    own.approveLast();
    const second = await runMigrationOp({ ...config(), gates: "own" }, own.port, () => deps());
    expect(second.status).toBe("gated");
    expect(second.gate).toMatchObject({ gate: "approve-migrate-events-kind-contract" });
    expect(await columnsOf(`${S}.events`)).toEqual(["id", "kind__chant_old", "kind"]);
  }, 300_000);
});
