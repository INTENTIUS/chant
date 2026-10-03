/**
 * Identity, serial and partitioned tables in the migration Op (#3322),
 * against the pinned server, and what it refuses among the rest:
 *
 * - `integer` to `bigint` on an identity primary key another table
 *   references: the identity moves to the new column under its sequence's
 *   name and carries on from where the old one stood.
 * - `serial` to `bigserial`: the sequence is handed to the new column,
 *   widened, and stays its default.
 * - A column of a partitioned table: every partition follows the
 *   partitioned table.
 * - Refused, each naming why: a partition, an inheritance tree, a column in
 *   the partition key, an index on a partitioned table, a generated column,
 *   a rename of an identity column.
 *
 * Needs Docker; skips cleanly without it.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { dockerAvailable, startTestPostgres, type TestPostgres } from "../testing/server";
import { ApprovingLedger, runMigrationOp, runOutcome } from "../testing/migration";
import type { PostgresClient } from "../live/client";
import { planPgAgainstServer } from "../plan/commands";
import { postgresApply } from "../../op/activities/postgres-apply";
import { postgresMigrationPlan, type PostgresMigrationDeps } from "../../op/activities/postgres-migration";
import type { PostgresMigrationOpConfig } from "./op";

const enabled = await dockerAvailable();
let server: TestPostgres | undefined;
let admin: PostgresClient | undefined;
const dir = mkdtempSync(join(tmpdir(), "chant-pg-kinds-"));

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
  config: { ownership: MARKER, sql: { profiles: { e2e: { url: server!.endpoint().url, password: { env: "PG_E2E_PASSWORD" } } } } },
  env: { PG_E2E_PASSWORD: server!.endpoint().password },
});
const deps = (): PostgresMigrationDeps => ({ ...profile(), log: () => undefined });
const apply = (file: string) => postgresApply({ buildPath: join(dir, file), environment: "e2e" }, undefined, { ...profile(), log: () => undefined });
const plan = (file: string) => planPgAgainstServer("e2e", join(dir, file), profile());
const one = async <T>(sql: string): Promise<T> => (await admin!.query<T>(sql))[0]!;
const schemaObj = (name: string): Obj => ({ export: name, type: "Postgres::Schema", ddl: `CREATE SCHEMA ${name}` });
const table = (exportName: string, schema: string, ddl: string, dependsOn: string[] = []): Obj => ({ export: exportName, type: "Postgres::Table", dependsOn: [schema, ...dependsOn], ddl });
const config = (over: Pick<PostgresMigrationOpConfig, "name" | "table" | "column" | "output"> & Partial<PostgresMigrationOpConfig>): PostgresMigrationOpConfig => ({
  env: "e2e",
  build: false,
  path: dir,
  retain: "0s",
  stack: MARKER.stack,
  ownershipEnv: MARKER.env,
  ...over,
});
const typeOf = async (table: string, column: string) =>
  (await one<{ t: string }>(`SELECT pg_catalog.format_type(atttypid, atttypmod) AS t FROM pg_catalog.pg_attribute WHERE attrelid = '${table}'::regclass AND attname = '${column}'`)).t;

/** Run the Op, approving each gate, until it is done; `between` runs after the first run (writes during the migration). */
async function runToEnd(c: PostgresMigrationOpConfig, between?: () => Promise<void>) {
  const ledger = new ApprovingLedger();
  const runs = [];
  for (let i = 0; i < 4; i++) {
    const r = await runMigrationOp(c, ledger.port, deps);
    runs.push(r);
    if (i === 0) await between?.();
    if (r.status !== "gated") break;
    ledger.approveLast();
  }
  return runs;
}

describe.skipIf(!enabled)("an identity primary key another table references, integer to bigint", () => {
  test("the identity moves to the bigint column under its sequence's name and carries on where it stood", async () => {
    const IDN = schemaObj("idn");
    const users = (t: string) => table("users", "idn", `CREATE TABLE idn.users (id ${t} GENERATED ALWAYS AS IDENTITY PRIMARY KEY, name text NOT NULL)`);
    const POSTS = table("posts", "idn", "CREATE TABLE idn.posts (id bigint PRIMARY KEY, user_id integer NOT NULL REFERENCES idn.users (id))", ["users"]);
    await apply(writeBuild("idn-v1.json", [IDN, users("integer"), POSTS]));
    await admin!.query("INSERT INTO idn.users (name) SELECT 'u' || g FROM generate_series(1, 1500) g");
    await admin!.query("INSERT INTO idn.posts SELECT g, (g % 1500) + 1 FROM generate_series(1, 2000) g");
    writeBuild("idn-v2.json", [IDN, users("bigint"), POSTS]);

    const runs = await runToEnd(config({ name: "migrate-users-id", table: "idn.users", column: "id", output: "idn-v2.json" }), async () => {
      // A writer during the migration takes its id from the old identity; the trigger fills the new column.
      await admin!.query("INSERT INTO idn.users (name) VALUES ('during')");
    });
    expect(runs.map((r) => r.status)).toEqual(["gated", "gated", "ok"]);
    expect(String(runOutcome(runs[0]!, "Verification"))).toMatch(/foreign-key posts_user_id_fkey, key users_pkey carried over/);
    expect(await typeOf("idn.users", "id")).toBe("bigint");
    expect(await one("SELECT a.attidentity::text AS identity, pg_catalog.pg_get_serial_sequence('idn.users', 'id') AS seq FROM pg_catalog.pg_attribute a WHERE a.attrelid = 'idn.users'::regclass AND a.attname = 'id'")).toEqual({
      identity: "a",
      seq: "idn.users_id_seq",
    });
    expect(await one("SELECT data_type::text AS t FROM pg_catalog.pg_sequences WHERE schemaname = 'idn' AND sequencename = 'users_id_seq'")).toEqual({ t: "bigint" });
    // The next id carries on from the last one the old identity gave.
    expect(await one("INSERT INTO idn.users (name) VALUES ('after') RETURNING id::int AS id")).toEqual({ id: 1502 });
    await admin!.query("INSERT INTO idn.posts VALUES (5000, 1502)");
    expect((await plan("idn-v2.json")).changes).toEqual([]);
  }, 300_000);
});

describe.skipIf(!enabled)("a serial column widened to bigserial", () => {
  test("the sequence is handed to the new column, widened, and stays its default", async () => {
    const SR = schemaObj("sr");
    const items = (t: string) => table("items", "sr", `CREATE TABLE sr.items (id ${t} PRIMARY KEY, v text)`);
    await apply(writeBuild("sr-v1.json", [SR, items("serial")]));
    await admin!.query("INSERT INTO sr.items (v) SELECT 'v' || g FROM generate_series(1, 800) g");
    writeBuild("sr-v2.json", [SR, items("bigserial")]);
    // serial to bigserial is integer to bigint, SQLPG207, with the sequence widened: the plan prints it unqualified.
    expect((await plan("sr-v2.json")).changes.map((c) => [c.rule, c.field, c.before, c.after])).toEqual([["SQLPG207", "columns.id.type", "serial", "bigserial"]]);

    const runs = await runToEnd(config({ name: "migrate-items-id", table: "sr.items", column: "id", output: "sr-v2.json" }), async () => {
      await admin!.query("INSERT INTO sr.items (v) VALUES ('during')");
    });
    expect(runs.map((r) => r.status)).toEqual(["gated", "gated", "ok"]);
    expect(await typeOf("sr.items", "id")).toBe("bigint");
    expect(await one("SELECT pg_catalog.pg_get_serial_sequence('sr.items', 'id') AS seq, (SELECT data_type::text FROM pg_catalog.pg_sequences WHERE sequencename = 'items_id_seq') AS t")).toEqual({
      seq: "sr.items_id_seq",
      t: "bigint",
    });
    expect(await one("INSERT INTO sr.items (v) VALUES ('after') RETURNING id::int AS id")).toEqual({ id: 802 });
    expect((await plan("sr-v2.json")).changes).toEqual([]);
  }, 300_000);
});

describe.skipIf(!enabled)("a column of a partitioned table", () => {
  test("text to numeric: every partition follows the partitioned table", async () => {
    const PT = schemaObj("pt");
    const events = (t: string) => table("events", "pt", `CREATE TABLE pt.events (id bigint, at date NOT NULL, amount ${t} NOT NULL, PRIMARY KEY (id, at)) PARTITION BY RANGE (at)`);
    const part = (y: number): Obj => table(`events${y}`, "pt", `CREATE TABLE pt.events_${y} PARTITION OF pt.events FOR VALUES FROM ('${y}-01-01') TO ('${y + 1}-01-01')`, ["events"]);
    await apply(writeBuild("pt-v1.json", [PT, events("text"), part(2025), part(2026)]));
    await admin!.query("INSERT INTO pt.events SELECT g, DATE '2025-06-01' + (g % 400), (g % 90) || '.5' FROM generate_series(1, 1200) g");
    writeBuild("pt-v2.json", [PT, events("numeric(10,2)"), part(2025), part(2026)]);
    expect((await plan("pt-v2.json")).changes.map((c) => [c.rule, c.field])).toEqual([["SQLPG208", "columns.amount.type"]]);

    const runs = await runToEnd(config({ name: "migrate-events-amount", table: "pt.events", column: "amount", output: "pt-v2.json", batchSize: 500 }), async () => {
      await admin!.query("INSERT INTO pt.events VALUES (9000, DATE '2026-03-01', '2.25')");
    });
    expect(runs.map((r) => r.status)).toEqual(["gated", "gated", "ok"]);
    expect(runOutcome(runs[0]!, "Filled")).toBe(3);
    for (const t of ["pt.events", "pt.events_2025", "pt.events_2026"]) expect(await typeOf(t, "amount")).toBe("numeric(10,2)");
    expect(await one("SELECT amount::text AS a FROM pt.events WHERE id = 9000")).toEqual({ a: "2.25" });
    expect(await one("SELECT count(*)::int AS n FROM pg_catalog.pg_attribute WHERE attrelid IN ('pt.events'::regclass, 'pt.events_2025'::regclass, 'pt.events_2026'::regclass) AND attname LIKE 'amount__chant%' AND NOT attisdropped")).toEqual({ n: 0 });
    expect((await plan("pt-v2.json")).changes).toEqual([]);
  }, 300_000);
});

describe.skipIf(!enabled)("what the Op refuses among the rest", () => {
  const RF = schemaObj("rf");
  const refusal = (tableName: string, column: string, output: string) =>
    postgresMigrationPlan({ table: tableName, column, buildPath: output, environment: "e2e", stack: MARKER.stack, ownershipEnv: MARKER.env, cwd: dir }, undefined, deps()).then(
      () => "",
      (e: unknown) => String((e as Error).message),
    );

  test("a partition, an inheritance tree, the partition key, an index on a partitioned table, a generated column, a renamed identity", async () => {
    const parted = (v: string, key = "at") => table("parted", "rf", `CREATE TABLE rf.parted (id bigint, at date, v ${v}, PRIMARY KEY (id, at)) PARTITION BY RANGE (${key})`);
    const p1 = table("parted1", "rf", "CREATE TABLE rf.parted1 PARTITION OF rf.parted FOR VALUES FROM ('2025-01-01') TO ('2026-01-01')", ["parted"]);
    const parent = (v: string) => table("parent", "rf", `CREATE TABLE rf.parent (id bigint PRIMARY KEY, v ${v})`);
    const gen = (g: string) => table("gen", "rf", `CREATE TABLE rf.gen (id bigint PRIMARY KEY, a integer, g ${g} GENERATED ALWAYS AS (a * 2) STORED)`);
    const ident = (c: string, hint = "") => table("ident", "rf", `CREATE TABLE rf.ident (\n  ${c} integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,${hint}\n  v text\n)`);
    await apply(writeBuild("rf-v1.json", [RF, parted("integer"), p1, parent("integer"), gen("integer"), ident("id")]));
    await admin!.query("CREATE TABLE rf.child (extra text) INHERITS (rf.parent)");
    await admin!.query("CREATE INDEX parted_v_idx ON rf.parted (v)");
    writeBuild("rf-v2.json", [RF, parted("bigint"), p1, parent("bigint"), gen("bigint"), ident("key", " -- previously: id")]);

    expect(await refusal("rf.parted1", "v", "rf-v2.json")).toMatch(/^rf\.parted1 is a partition of rf\.parted\. A partition's columns are its partitioned table's: run the Op on rf\.parted/);
    expect(await refusal("rf.parent", "v", "rf-v2.json")).toMatch(/^rf\.parent has inheritance children \(rf\.child\)\. The Op does not migrate inheritance trees: a write to a child table does not fire the parent's dual-write trigger/);
    expect(await refusal("rf.parted", "v", "rf-v2.json")).toMatch(/index rf\.parted_v_idx is a partitioned index, which cannot be built CONCURRENTLY/);
    expect(await refusal("rf.gen", "g", "rf-v2.json")).toMatch(/^rf\.gen\.g is a generated column\. There is no expand and contract for one/);
    expect(await refusal("rf.ident", "key", "rf-v2.json")).toMatch(/sequence rf\.ident_id_seq gives the column its values \(an identity column\); during a rename/);

    await admin!.query("DROP INDEX rf.parted_v_idx");
    writeBuild("rf-v3.json", [RF, parted("integer", "v"), p1]);
    await admin!.query("DROP TABLE rf.parted");
    await apply(writeBuild("rf-v3.json", [RF, table("parted", "rf", "CREATE TABLE rf.parted (id bigint, at date, v integer, PRIMARY KEY (id, v)) PARTITION BY RANGE (v)")]));
    writeBuild("rf-v4.json", [RF, table("parted", "rf", "CREATE TABLE rf.parted (id bigint, at date, v bigint, PRIMARY KEY (id, v)) PARTITION BY RANGE (v)")]);
    expect(await refusal("rf.parted", "v", "rf-v4.json")).toMatch(/rf\.parted\.v is in the partition key \(RANGE \(v\)\)/);
  }, 300_000);
});
