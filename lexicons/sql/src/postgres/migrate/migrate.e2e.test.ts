/**
 * The expand-and-contract migration against the pinned server (#3281).
 *
 * - A column rename: the plan and the applier refuse it and name the Op; the
 *   Op stops at its gate with the verification on the run record while old
 *   writers keep working, switches once approved with both names written,
 *   and drops the old name at the contract gate.
 * - A column type change across kinds: the same, with the columns swapped by
 *   name at the switch and the old one kept unwritten until the contract.
 * - A failure: a value the new type cannot hold fails the backfill, and
 *   onFailure drops what the expand added.
 * - An interrupted backfill: stopped after three batches, then killed before
 *   a batch's commit, then resumed: the receipts skip what was filled, and
 *   no row is updated twice.
 *
 * Runs the Op through core's local executor with an in-memory gate ledger.
 * Needs Docker; skips cleanly without it.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { normalizeApply } from "@intentius/chant/apply";
import { OpRunFailure, type GateLedgerPort, type OpRunResult } from "@intentius/chant/op";
import { dockerAvailable, startTestPostgres, type TestPostgres } from "../testing/server";
import type { PostgresClient } from "../live/client";
import { planPgAgainstServer } from "../plan/commands";
import { postgresApply } from "../../op/activities/postgres-apply";
import { toApplyResult } from "../../op/activities";
import * as migrationActivities from "../../op/activities/postgres-migration";
import type { PostgresMigrationDeps } from "../../op/activities/postgres-migration";
import type { PostgresMigrationArgs, PostgresMigrationOpConfig } from "./op";
import { ApprovingLedger, runMigrationOp, runOutcome } from "../testing/migration";
import { POSTGRES_RECEIPTS_TABLE } from "./receipts";

const enabled = await dockerAvailable();
let server: TestPostgres | undefined;
let admin: PostgresClient | undefined;
const dir = mkdtempSync(join(tmpdir(), "chant-pg-migrate-"));

beforeAll(async () => {
  if (!enabled) return;
  server = await startTestPostgres();
  admin = await server.connect();
}, 600_000);

afterAll(async () => {
  await admin?.end();
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

const MARKER = { stack: "e2e", env: "test" };
const profile = () => ({
  config: {
    ownership: MARKER,
    sql: { profiles: { e2e: { url: server!.endpoint().url, password: { env: "PG_E2E_PASSWORD" } } } },
  },
  env: { PG_E2E_PASSWORD: server!.endpoint().password },
});
const deps = (extra: Partial<PostgresMigrationDeps> = {}): PostgresMigrationDeps => ({ ...profile(), log: () => undefined, ...extra });
const apply = (file: string) => postgresApply({ buildPath: join(dir, file), environment: "e2e" }, undefined, { ...profile(), log: () => undefined });
const plan = (file: string) => planPgAgainstServer("e2e", join(dir, file), profile());
const one = async <T>(sql: string): Promise<T> => (await admin!.query<T>(sql))[0]!;
const columnsOf = async (table: string) =>
  (await admin!.query<{ name: string }>(`SELECT attname AS name FROM pg_attribute WHERE attrelid = '${table}'::regclass AND attnum > 0 AND NOT attisdropped ORDER BY attnum`)).map((r) => r.name);
const receiptsTableExists = async (schema: string) => (await one<{ t: string | null }>(`SELECT to_regclass('${schema}.${POSTGRES_RECEIPTS_TABLE}')::text AS t`)).t !== null;

const runOp = (config: PostgresMigrationOpConfig, gates: GateLedgerPort): Promise<OpRunResult> => runMigrationOp(config, gates, () => deps());
const Ledger = ApprovingLedger;
const outcome = runOutcome;
const failed = async (p: Promise<unknown>): Promise<OpRunFailure> => {
  const e = await p.then(
    () => undefined,
    (err: unknown) => err,
  );
  expect(e).toBeInstanceOf(OpRunFailure);
  return e as OpRunFailure;
};

// Each scenario has a schema of its own, so its plans read only its own table.
const schemaObj = (name: string): Obj => ({ export: name, type: "Postgres::Schema", ddl: `CREATE SCHEMA ${name}` });
const APP = schemaObj("app");
const SHOP = schemaObj("shop");
const REF = schemaObj("ref");
const EV = schemaObj("ev");

describe.skipIf(!enabled)("a column rename, migrated through its gates", () => {
  const usersDdl = (column: string) => `CREATE TABLE app.users (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  ${column}
  name text
);
COMMENT ON TABLE app.users IS 'One row per account'`;
  const V1: Obj = { export: "users", type: "Postgres::Table", dependsOn: ["app"], ddl: usersDdl("email text NOT NULL,") };
  const V2: Obj = { ...V1, ddl: usersDdl("login text NOT NULL, -- previously: email") };
  const config = (): PostgresMigrationOpConfig => ({
    name: "migrate-users-login",
    env: "e2e",
    table: "app.users",
    column: "login",
    build: false,
    path: dir,
    output: "users-v2.json",
    retain: "0s",
    batchSize: 1000,
    stack: MARKER.stack,
    ownershipEnv: MARKER.env,
  });
  const ledger = new Ledger();

  test("the plan and the applier refuse the rename in place and name the Op", async () => {
    const applied = normalizeApply(toApplyResult(await apply(writeBuild("users-v1.json", [APP, V1]))));
    expect(applied.notAttempted).toEqual([]);
    await admin!.query("INSERT INTO app.users (email, name) SELECT 'u' || g || '@example.com', 'n' || g FROM generate_series(1, 2500) g");

    writeBuild("users-v2.json", [APP, V2]);
    const p = await plan("users-v2.json");
    expect(p.refused.map((c) => c.rule)).toEqual(["SQLPG205"]);
    expect(p.migrationOps).toEqual([expect.objectContaining({ table: "app.users", column: "login", env: "e2e", rule: "SQLPG205" })]);
    expect(p.migrationOps![0]!.declaration).toBe('export const { op } = PostgresMigrationOp({ name: "migrate-app-users-login", env: "e2e", table: "app.users", column: "login" });');

    const refused = normalizeApply(toApplyResult(await apply("users-v2.json")));
    expect(refused.notAttempted).toEqual([expect.objectContaining({ name: "app.users", reason: "unsupported-kind" })]);
    expect(refused.notAttempted[0]!.detail).toContain('PostgresMigrationOp({ table: "app.users", column: "login", ... })');
  }, 180_000);

  test("the first run fills the new column and stops at the switch gate with the verification attached", async () => {
    const r = await runOp(config(), ledger.port);
    expect(r.status).toBe("gated");
    expect(r.gate).toMatchObject({ gate: "approve-migrate-users-login" });
    expect(r.gate!.planDigest).toMatch(/^jcs1-sha256:/);
    expect(outcome(r, "MigrationState")).toBe("migrate");
    expect(outcome(r, "Change")).toBe("rename");
    expect(outcome(r, "Filled")).toBe(3);
    expect(outcome(r, "BackfilledRows")).toBe(2500);
    expect(outcome(r, "VerifiedRows")).toBe(2500);
    expect(String(outcome(r, "Verification"))).toMatch(/2500 row\(s\), login equal to email in every one/);
    expect(await one("SELECT count(*)::int AS n FROM app.users WHERE login IS DISTINCT FROM email")).toEqual({ n: 0 });
    // Nothing visible to a plan: the working column is left out, and the rename is still what is refused.
    expect((await plan("users-v2.json")).changes.map((c) => c.rule)).toEqual(["SQLPG205"]);

    // Writers on the old name go on working, and the trigger fills the new one.
    await admin!.query("INSERT INTO app.users (email) VALUES ('late@example.com')");
    expect(await one("SELECT login FROM app.users WHERE email = 'late@example.com'")).toEqual({ login: "late@example.com" });
    await admin!.query("UPDATE app.users SET email = 'first@example.com' WHERE id = 1");
    expect(await one("SELECT login FROM app.users WHERE id = 1")).toEqual({ login: "first@example.com" });

    // Running again before anyone approves fills nothing again: the three
    // batches are skipped by their receipts, and the gate stands as it was.
    const again = await runOp(config(), ledger.port);
    expect(again.status).toBe("gated");
    expect(outcome(again, "Skipped")).toBe(3);
    expect(outcome(again, "Filled")).toBe(0);
    expect(again.gate!.planDigest).toBe(r.gate!.planDigest);
  }, 300_000);

  test("approved, it switches: the new name is the declared column, both names are written, and it stops at the contract gate", async () => {
    ledger.approveLast();
    const r = await runOp(config(), ledger.port);
    expect(r.status).toBe("gated");
    expect(r.gate).toMatchObject({ gate: "approve-migrate-users-login-contract" });
    expect(outcome(r, "OldColumn")).toBe("email");
    expect(await one("SELECT attnotnull FROM pg_attribute WHERE attrelid = 'app.users'::regclass AND attname = 'login'")).toEqual({ attnotnull: true });
    expect(await one("SELECT count(*)::int AS n FROM pg_constraint WHERE conrelid = 'app.users'::regclass AND contype = 'c'")).toEqual({ n: 0 });
    // The plan sees the declaration: login, and email is left out until the contract drops it.
    expect((await plan("users-v2.json")).changes).toEqual([]);

    // A reader or writer still on the old name works until the contract; a new writer fills both.
    await admin!.query("INSERT INTO app.users (login) VALUES ('new@example.com')");
    expect(await one("SELECT email FROM app.users WHERE login = 'new@example.com'")).toEqual({ email: "new@example.com" });
    await admin!.query("INSERT INTO app.users (email) VALUES ('old@example.com')");
    expect(await one("SELECT login FROM app.users WHERE email = 'old@example.com'")).toEqual({ login: "old@example.com" });
  }, 300_000);

  test("approved again, it drops the old name, its trigger and its receipts, and the server holds the declaration", async () => {
    ledger.approveLast();
    const r = await runOp(config(), ledger.port);
    expect(r.status).toBe("ok");
    expect(outcome(r, "Dropped")).toBe(true);
    expect(await columnsOf("app.users")).toEqual(["id", "name", "login"]);
    expect(await one("SELECT count(*)::int AS n FROM pg_trigger WHERE tgrelid = 'app.users'::regclass AND NOT tgisinternal")).toEqual({ n: 0 });
    expect(await receiptsTableExists("app")).toBe(false);
    expect((await plan("users-v2.json")).changes).toEqual([]);
    expect(await one("SELECT count(*)::int AS n FROM app.users")).toEqual({ n: 2503 });

    const done = await runOp(config(), ledger.port);
    expect(done.status).toBe("ok");
    expect(outcome(done, "MigrationState")).toBe("done");
  }, 300_000);
});

describe.skipIf(!enabled)("a column type change across kinds, migrated through its gates", () => {
  const ordersDdl = (amount: string) => `CREATE TABLE shop.orders (id bigint PRIMARY KEY, ${amount}, note text)`;
  const V1: Obj = { export: "orders", type: "Postgres::Table", dependsOn: ["shop"], ddl: ordersDdl("amount text NOT NULL") };
  const V2: Obj = { ...V1, ddl: `${ordersDdl("amount numeric(12,2) NOT NULL DEFAULT 0")};\nCOMMENT ON COLUMN shop.orders.amount IS 'In euros'` };
  const config = (): PostgresMigrationOpConfig => ({
    name: "migrate-orders-amount",
    env: "e2e",
    table: "shop.orders",
    column: "amount",
    build: false,
    path: dir,
    output: "orders-v2.json",
    retain: "0s",
    batchSize: 500,
    stack: MARKER.stack,
    ownershipEnv: MARKER.env,
  });
  const ledger = new Ledger();

  test("refused in place, then filled, switched by name and contracted", async () => {
    await apply(writeBuild("orders-v1.json", [SHOP, V1]));
    await admin!.query("INSERT INTO shop.orders (id, amount) SELECT g, (g % 100) || '.25' FROM generate_series(1, 1200) g");
    writeBuild("orders-v2.json", [SHOP, V2]);
    const p = await plan("orders-v2.json");
    expect(p.refused.map((c) => [c.rule, c.field])).toEqual([["SQLPG208", "columns.amount.type"]]);
    expect(p.migrationOps?.map((o) => [o.table, o.column])).toEqual([["shop.orders", "amount"]]);

    const first = await runOp(config(), ledger.port);
    expect(first.status).toBe("gated");
    expect(outcome(first, "Change")).toBe("type");
    expect(outcome(first, "Filled")).toBe(3);
    expect(outcome(first, "VerifiedRows")).toBe(1200);
    expect(await one("SELECT format_type(atttypid, atttypmod) AS t FROM pg_attribute WHERE attrelid = 'shop.orders'::regclass AND attname = 'amount__chant_new'")).toEqual({ t: "numeric(12,2)" });
    // A write during the migration is converted by the trigger.
    await admin!.query("INSERT INTO shop.orders (id, amount) VALUES (5000, '7.5')");
    expect(await one("SELECT amount__chant_new::text AS v FROM shop.orders WHERE id = 5000")).toEqual({ v: "7.50" });

    ledger.approveLast();
    const switched = await runOp(config(), ledger.port);
    expect(switched.status).toBe("gated");
    expect(switched.gate).toMatchObject({ gate: "approve-migrate-orders-amount-contract" });
    expect(outcome(switched, "OldColumn")).toBe("amount__chant_old");
    expect(await one("SELECT format_type(atttypid, atttypmod) AS t, attnotnull AS nn FROM pg_attribute WHERE attrelid = 'shop.orders'::regclass AND attname = 'amount'")).toEqual({
      t: "numeric(12,2)",
      nn: true,
    });
    expect(await one("SELECT col_description('shop.orders'::regclass, (SELECT attnum FROM pg_attribute WHERE attrelid = 'shop.orders'::regclass AND attname = 'amount')) AS c")).toEqual({ c: "In euros" });
    expect(await one("SELECT sum(amount)::text AS s FROM shop.orders")).toEqual({ s: "59707.50" });
    expect((await plan("orders-v2.json")).changes).toEqual([]);
    // Writers now write the new type; the old column is kept as it was and no longer written.
    await admin!.query("INSERT INTO shop.orders (id, amount) VALUES (5001, 3.333)");
    expect(await one("SELECT amount::text AS v, amount__chant_old AS old FROM shop.orders WHERE id = 5001")).toEqual({ v: "3.33", old: null });
    await admin!.query("INSERT INTO shop.orders (id) VALUES (5002)");
    expect(await one("SELECT amount::text AS v FROM shop.orders WHERE id = 5002")).toEqual({ v: "0.00" });

    ledger.approveLast();
    const contracted = await runOp(config(), ledger.port);
    expect(contracted.status).toBe("ok");
    expect(await columnsOf("shop.orders")).toEqual(["id", "note", "amount"]);
    expect((await plan("orders-v2.json")).changes).toEqual([]);
  }, 300_000);
});

describe.skipIf(!enabled)("a failure runs onFailure, which drops what the expand added", () => {
  const V1: Obj = { export: "codes", type: "Postgres::Table", dependsOn: ["ref"], ddl: "CREATE TABLE ref.codes (id integer PRIMARY KEY, code text)" };
  const V2: Obj = { ...V1, ddl: "CREATE TABLE ref.codes (id integer PRIMARY KEY, code integer)" };

  test("a value the new type cannot hold fails the backfill; the new column, trigger, function and receipts are dropped", async () => {
    await apply(writeBuild("codes-v1.json", [REF, V1]));
    await admin!.query("INSERT INTO ref.codes SELECT g, g::text FROM generate_series(1, 300) g");
    await admin!.query("UPDATE ref.codes SET code = 'n/a' WHERE id = 250");
    writeBuild("codes-v2.json", [REF, V2]);

    const failure = await failed(
      runOp({ name: "migrate-codes", env: "e2e", table: "ref.codes", column: "code", build: false, path: dir, output: "codes-v2.json", batchSize: 100, stack: MARKER.stack, ownershipEnv: MARKER.env }, new Ledger().port),
    );
    const records = failure.result.records;
    expect(records.find((x) => x.fn === "postgresMigrationBackfill")?.error).toMatch(/invalid input syntax for type integer: "n\/a"/);
    expect(records.find((x) => x.fn === "postgresMigrationCompensate")?.status).toBe("ok");
    expect(await columnsOf("ref.codes")).toEqual(["id", "code"]);
    expect(await one("SELECT count(*)::int AS n FROM pg_trigger WHERE tgrelid = 'ref.codes'::regclass AND NOT tgisinternal")).toEqual({ n: 0 });
    expect(await one("SELECT count(*)::int AS n FROM pg_proc WHERE proname = 'codes__code__chant_sync'")).toEqual({ n: 0 });
    expect(await receiptsTableExists("ref")).toBe(false);
    expect((await plan("codes-v2.json")).changes.map((c) => c.rule)).toEqual(["SQLPG208"]);
  }, 300_000);
});

describe.skipIf(!enabled)("an interrupted backfill resumes from its receipts", () => {
  const V1: Obj = { export: "events", type: "Postgres::Table", dependsOn: ["ev"], ddl: "CREATE TABLE ev.events (id bigint PRIMARY KEY, kind varchar(20) NOT NULL)" };
  const V2: Obj = { ...V1, ddl: "CREATE TABLE ev.events (id bigint PRIMARY KEY, kind varchar(10) NOT NULL)" };
  const args = (): PostgresMigrationArgs => ({ table: "ev.events", column: "kind", buildPath: "events-v2.json", environment: "e2e", batchSize: 1000, stack: MARKER.stack, ownershipEnv: MARKER.env, cwd: dir });
  const m = migrationActivities;

  test("stopped after three batches, killed before a commit, then resumed: every row updated once", async () => {
    await apply(writeBuild("events-v1.json", [EV, V1]));
    await admin!.query("INSERT INTO ev.events SELECT g, CASE WHEN g % 2 = 0 THEN 'click' ELSE 'view' END FROM generate_series(0, 5999) g");
    // Every row update the backfill makes, counted by a trigger of the application's own.
    await admin!.query("CREATE SCHEMA audit");
    await admin!.query("CREATE TABLE audit.updates (id bigint)");
    await admin!.query("CREATE FUNCTION audit.count_update() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN INSERT INTO audit.updates VALUES (NEW.id); RETURN NEW; END $$");
    await admin!.query("CREATE TRIGGER audit_update AFTER UPDATE ON ev.events FOR EACH ROW EXECUTE FUNCTION audit.count_update()");
    writeBuild("events-v2.json", [EV, V2]);

    // varchar(20) to varchar(10) is a rewrite in place (SQLPG207), which the Op makes in batches instead.
    expect((await plan("events-v2.json")).changes.map((c) => c.rule)).toEqual(["SQLPG207"]);
    expect(await m.postgresMigrationPlan(args(), undefined, deps())).toMatchObject({ state: "migrate", change: "type" });
    await m.postgresMigrationExpand(args(), undefined, deps());
    await m.postgresMigrationDualWrite(args(), undefined, deps());

    // Interrupted (Ctrl-C) after the third batch.
    const stop = new AbortController();
    let done = 0;
    const interrupted = await m
      .postgresMigrationBackfill(args(), stop.signal, deps({ backfill: { afterBatch: () => void (++done === 3 && stop.abort()) } }))
      .then(
        () => undefined,
        (e: unknown) => e,
      );
    expect(interrupted).toBeDefined();
    expect(await one("SELECT count(*)::int AS n FROM ev.events WHERE kind__chant_new IS NOT NULL")).toEqual({ n: 3000 });

    // Killed after the fourth batch's UPDATE and receipt, before its commit: neither is kept.
    await expect(
      m.postgresMigrationBackfill(
        args(),
        undefined,
        deps({
          backfill: {
            beforeCommit: () => {
              throw new Error("killed before the commit");
            },
          },
        }),
      ),
    ).rejects.toThrow(/killed before the commit/);
    expect(await one("SELECT count(*)::int AS n FROM ev.events WHERE kind__chant_new IS NOT NULL")).toEqual({ n: 3000 });
    expect(await one(`SELECT count(*)::int AS n FROM ev.${POSTGRES_RECEIPTS_TABLE}`)).toEqual({ n: 3 });

    // Resumed: three batches skipped by receipt, three filled.
    const resumed = await m.postgresMigrationBackfill(args(), undefined, deps());
    expect(resumed).toMatchObject({ batches: 6, skipped: 3, filled: 3, rows: 3000 });
    expect(await one("SELECT count(*)::int AS rows, count(DISTINCT id)::int AS ids, max(n)::int AS most FROM (SELECT id, count(*) AS n FROM audit.updates GROUP BY id) s")).toEqual({
      rows: 6000,
      ids: 6000,
      most: 1,
    });
    expect(await one(`SELECT count(*)::int AS n FROM ev.${POSTGRES_RECEIPTS_TABLE} WHERE address LIKE 'e2e/test/migrate/ev.events.kind/%'`)).toEqual({ n: 6 });
    expect(await m.postgresMigrationVerify(args(), undefined, deps())).toMatchObject({ rows: 6000, mismatched: 0 });

    // The receipts table is chant's own bookkeeping, not a declared schema.
    expect((await plan("events-v2.json")).changes.map((c) => c.object)).not.toContain(`relation ev.${POSTGRES_RECEIPTS_TABLE}`);

    const dropped = await m.postgresMigrationCompensate(args(), undefined, deps());
    expect(dropped.dropped).toEqual(["trigger kind__chant_sync", "function ev.events__kind__chant_sync", "column ev.events.kind__chant_new", "6 receipt(s)"]);
    expect(await receiptsTableExists("ev")).toBe(false);
  }, 300_000);
});
