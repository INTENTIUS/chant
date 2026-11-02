/**
 * An index on a partitioned table's migrated column (#3333), against the
 * pinned server: the Op builds it per partition and attaches it, and what
 * stays refused.
 *
 * - `text` to `numeric` on a column with a plain index and a partial unique
 *   index, on a table with a default partition, two partitions and a
 *   sub-partitioned one: every partition's index is built `CONCURRENTLY`
 *   (never under a lock that blocks writes), attached, and the partitioned
 *   index is valid and named as declared after the switch.
 * - A write while the Op waits at its gate lands in the new column.
 * - A unique constraint on the column stays refused, naming why.
 *
 * Needs Docker; skips cleanly without it.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { dockerAvailable, startTestPostgres, type TestPostgres } from "../testing/server";
import { ApprovingLedger, runMigrationOp } from "../testing/migration";
import type { PostgresClient } from "../live/client";
import { planPgAgainstServer } from "../plan/commands";
import { postgresApply } from "../../op/activities/postgres-apply";
import { postgresMigrationPlan, type PostgresMigrationDeps } from "../../op/activities/postgres-migration";
import type { PostgresMigrationOpConfig } from "./op";

const enabled = await dockerAvailable();
let server: TestPostgres | undefined;
let admin: PostgresClient | undefined;
const dir = mkdtempSync(join(tmpdir(), "chant-pg-partition-"));

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

describe.skipIf(!enabled)("a plain and a partial unique index on a partitioned table's migrated column", () => {
  const PI = schemaObj("pi");
  const events = (t: string): Obj => table("events", "pi", `CREATE TABLE pi.events (id bigint, at date NOT NULL, amount ${t} NOT NULL, PRIMARY KEY (id, at)) PARTITION BY RANGE (at)`);
  const part = (y: number): Obj => table(`events${y}`, "pi", `CREATE TABLE pi.events_${y} PARTITION OF pi.events FOR VALUES FROM ('${y}-01-01') TO ('${y + 1}-01-01')`, ["events"]);
  const sub = table("events2027", "pi", "CREATE TABLE pi.events_2027 PARTITION OF pi.events FOR VALUES FROM ('2027-01-01') TO ('2028-01-01') PARTITION BY RANGE (at)", ["events"]);
  const q1 = table("events2027q1", "pi", "CREATE TABLE pi.events_2027_q1 PARTITION OF pi.events_2027 FOR VALUES FROM ('2027-01-01') TO ('2027-04-01')", ["events2027"]);
  const byAmount: Obj = { export: "eventsByAmount", type: "Postgres::Index", dependsOn: ["events"], ddl: "CREATE INDEX events_amount_idx ON pi.events (amount)" };
  const uniq = (col: string): Obj => ({ export: "eventsUnique", type: "Postgres::Index", dependsOn: ["events"], ddl: `CREATE UNIQUE INDEX events_unique_idx ON pi.events (at, ${col}) WHERE id > 0` });
  const objects = (t: string, col: string) => [PI, events(t), part(2025), part(2026), sub, q1, { ...byAmount, ddl: `CREATE INDEX events_amount_idx ON pi.events (${col})` }, uniq(col)];

  test("each partition's index is built and attached, and the partitioned index takes its declared name", async () => {
    await apply(writeBuild("pi-v1.json", objects("text", "amount")));
    await admin!.query("INSERT INTO pi.events SELECT g, DATE '2025-01-01' + (g % 800), (g % 90) || '.5' FROM generate_series(1, 1500) g");
    writeBuild("pi-v2.json", objects("numeric(10,2)", "amount"));

    const ledger = new ApprovingLedger();
    const config: PostgresMigrationOpConfig = { name: "migrate-events-amount", env: "e2e", table: "pi.events", column: "amount", build: false, path: dir, output: "pi-v2.json", retain: "0s", stack: MARKER.stack, ownershipEnv: MARKER.env, batchSize: 500 };
    const statuses: string[] = [];
    for (let i = 0; i < 4; i++) {
      const r = await runMigrationOp(config, ledger.port, deps);
      statuses.push(r.status);
      if (i === 0) {
        // Waiting at the gate: the partitioned working index is valid, every leaf partition has its own, and writes land in the new column.
        expect(await one("SELECT indisvalid FROM pg_index WHERE indexrelid = 'pi.events_amount_idx__chant_new'::regclass")).toEqual({ indisvalid: true });
        expect(await one("SELECT count(*)::int AS n FROM pg_index i JOIN pg_inherits h ON h.inhrelid = i.indexrelid WHERE h.inhparent = 'pi.events_amount_idx__chant_new'::regclass")).toEqual({ n: 3 });
        await admin!.query("INSERT INTO pi.events VALUES (9000, DATE '2026-03-01', '2.25')");
        expect(await one("SELECT amount__chant_new::text AS a FROM pi.events WHERE id = 9000")).toEqual({ a: "2.25" });
      }
      if (r.status !== "gated") break;
      ledger.approveLast();
    }
    expect(statuses).toEqual(["gated", "gated", "ok"]);
    expect(await one("SELECT i.indisvalid, c.relkind::text AS kind, pg_get_indexdef(c.oid) AS def FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid WHERE c.oid = 'pi.events_amount_idx'::regclass")).toEqual({
      indisvalid: true,
      kind: "I",
      def: "CREATE INDEX events_amount_idx ON ONLY pi.events USING btree (amount)",
    });
    expect(await one("SELECT count(*)::int AS n FROM pg_class WHERE relnamespace = 'pi'::regnamespace AND relname LIKE '%\\_\\_chant\\_old'")).toEqual({ n: 0 });
    // The query planner uses a partition's index on the new column.
    await admin!.query("SET enable_seqscan = off");
    expect(JSON.stringify(await admin!.query("EXPLAIN SELECT * FROM pi.events_2025 WHERE amount = 2.5"))).toContain("Index");
    expect((await plan("pi-v2.json")).changes).toEqual([]);
  }, 300_000);
});

describe.skipIf(!enabled)("a key on a partitioned table's migrated column", () => {
  const PK = schemaObj("pk");
  const events = (t: string): Obj => table("events", "pk", `CREATE TABLE pk.events (id bigint, at date NOT NULL, amount ${t} NOT NULL, PRIMARY KEY (id, at, amount)) PARTITION BY RANGE (at)`);
  const part: Obj = table("events2025", "pk", "CREATE TABLE pk.events_2025 PARTITION OF pk.events FOR VALUES FROM ('2025-01-01') TO ('2026-01-01')", ["events"]);

  test("stays refused, naming why", async () => {
    await apply(writeBuild("pk-v1.json", [PK, events("text"), part]));
    writeBuild("pk-v2.json", [PK, events("numeric(10,2)"), part]);
    const message = await postgresMigrationPlan({ table: "pk.events", column: "amount", buildPath: "pk-v2.json", environment: "e2e", stack: MARKER.stack, ownershipEnv: MARKER.env, cwd: dir }, undefined, deps()).then(
      () => "",
      (e: unknown) => String((e as Error).message),
    );
    expect(message).toMatch(/primary key events_pkey on pk\.events: on a partitioned table a key cannot be attached from an index built CONCURRENTLY/);
  }, 300_000);
});
