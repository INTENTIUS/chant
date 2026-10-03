/**
 * The backfill's batches for a primary key that is not one integer column
 * (#3322), against the pinned server: a uuid key's boundaries are walked and
 * recorded once, and a resumed backfill finds the same batches and skips
 * the ones its receipts vouch for; a composite key and a text key run the
 * Op through its gates to the end.
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
import * as m from "../../op/activities/postgres-migration";
import type { PostgresMigrationArgs, PostgresMigrationOpConfig } from "./op";
import { POSTGRES_RECEIPTS_TABLE } from "./receipts";

const enabled = await dockerAvailable();
let server: TestPostgres | undefined;
let admin: PostgresClient | undefined;
const dir = mkdtempSync(join(tmpdir(), "chant-pg-batches-"));

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
const deps = (extra: Partial<m.PostgresMigrationDeps> = {}): m.PostgresMigrationDeps => ({ ...profile(), log: () => undefined, ...extra });
const apply = (file: string) => postgresApply({ buildPath: join(dir, file), environment: "e2e" }, undefined, { ...profile(), log: () => undefined });
const plan = (file: string) => planPgAgainstServer("e2e", join(dir, file), profile());
const one = async <T>(sql: string): Promise<T> => (await admin!.query<T>(sql))[0]!;
const schemaObj = (name: string): Obj => ({ export: name, type: "Postgres::Schema", ddl: `CREATE SCHEMA ${name}` });
const config = (over: Partial<PostgresMigrationOpConfig> & Pick<PostgresMigrationOpConfig, "name" | "table" | "column" | "output">): PostgresMigrationOpConfig => ({
  env: "e2e",
  build: false,
  path: dir,
  retain: "0s",
  stack: MARKER.stack,
  ownershipEnv: MARKER.env,
  ...over,
});

/** Run the Op until it is done, approving each gate it stops at. */
async function runToEnd(c: PostgresMigrationOpConfig) {
  const ledger = new ApprovingLedger();
  const runs = [];
  for (let i = 0; i < 4; i++) {
    const r = await runMigrationOp(c, ledger.port, () => deps());
    runs.push(r);
    if (r.status !== "gated") break;
    ledger.approveLast();
  }
  return runs;
}

describe.skipIf(!enabled)("a uuid primary key", () => {
  const UU = schemaObj("uu");
  const tokens = (score: string): Obj => ({ export: "tokens", type: "Postgres::Table", dependsOn: ["uu"], ddl: `CREATE TABLE uu.tokens (id uuid PRIMARY KEY, score ${score})` });
  const args = (): PostgresMigrationArgs => ({ table: "uu.tokens", column: "score", buildPath: "tokens-v2.json", environment: "e2e", batchSize: 1000, stack: MARKER.stack, ownershipEnv: MARKER.env, cwd: dir });

  test("boundaries walked and recorded once; a resumed backfill finds the same batches and updates no row twice", async () => {
    await apply(writeBuild("tokens-v1.json", [UU, tokens("text")]));
    await admin!.query("INSERT INTO uu.tokens SELECT gen_random_uuid(), (g % 50)::text FROM generate_series(1, 2500) g");
    await admin!.query("CREATE SCHEMA audit");
    await admin!.query("CREATE TABLE audit.updates (id uuid)");
    await admin!.query("CREATE FUNCTION audit.count_update() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN INSERT INTO audit.updates VALUES (NEW.id); RETURN NEW; END $$");
    await admin!.query("CREATE TRIGGER audit_update AFTER UPDATE ON uu.tokens FOR EACH ROW EXECUTE FUNCTION audit.count_update()");
    writeBuild("tokens-v2.json", [UU, tokens("integer")]);
    expect((await plan("tokens-v2.json")).changes.map((c) => c.rule)).toEqual(["SQLPG208"]);

    expect(await m.postgresMigrationPlan(args(), undefined, deps())).toMatchObject({ state: "migrate", summary: expect.stringContaining("batched by id") });
    await m.postgresMigrationExpand(args(), undefined, deps());
    await m.postgresMigrationDualWrite(args(), undefined, deps());

    // Interrupted after the first batch.
    const stop = new AbortController();
    const interrupted = await m.postgresMigrationBackfill(args(), stop.signal, deps({ backfill: { afterBatch: () => stop.abort() } })).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(interrupted).toBeDefined();
    const record = await one<{ e: string }>(`SELECT expectation AS e FROM uu.${POSTGRES_RECEIPTS_TABLE} WHERE address LIKE '%/migrate/uu.tokens.score/batches'`);
    const recorded = JSON.parse(record.e) as { keys: string[]; size: number; bounds: string[][] };
    expect(recorded).toMatchObject({ keys: ["id"], size: 1000 });
    expect(recorded.bounds).toHaveLength(3);
    expect(await one("SELECT count(*)::int AS n FROM uu.tokens WHERE score__chant_new IS NOT NULL")).toEqual({ n: 1000 });

    // Rows written meanwhile land anywhere in the key's order; the dual write fills them.
    await admin!.query("INSERT INTO uu.tokens SELECT gen_random_uuid(), '7' FROM generate_series(1, 500)");

    const resumed = await m.postgresMigrationBackfill(args(), undefined, deps());
    expect(resumed).toMatchObject({ batches: 3, skipped: 1, filled: 2, rows: 1500 });
    expect(await one("SELECT count(*)::int AS n FROM uu.tokens WHERE score__chant_new IS NULL")).toEqual({ n: 0 });
    // The recorded boundaries were read back, not walked again over 3000 rows.
    expect(await one<{ e: string }>(`SELECT expectation AS e FROM uu.${POSTGRES_RECEIPTS_TABLE} WHERE address LIKE '%/batches'`)).toEqual(record);
    expect(await one("SELECT count(*)::int AS rows, max(n)::int AS most FROM (SELECT id, count(*) AS n FROM audit.updates GROUP BY id) s")).toEqual({ rows: 2500, most: 1 });
    expect(await m.postgresMigrationVerify(args(), undefined, deps())).toMatchObject({ rows: 3000, mismatched: 0 });

    const again = await m.postgresMigrationBackfill(args(), undefined, deps());
    expect(again).toMatchObject({ batches: 3, skipped: 3, filled: 0 });
    const dropped = await m.postgresMigrationCompensate(args(), undefined, deps());
    expect(dropped.dropped.at(-1)).toBe("4 receipt(s)");
  }, 300_000);
});

describe.skipIf(!enabled)("a composite and a text primary key, through the gates", () => {
  test("(tenant_id, id): a varchar narrowed in batches of the key's order", async () => {
    const MT = schemaObj("mt");
    const events = (kind: string): Obj => ({ export: "events", type: "Postgres::Table", dependsOn: ["mt"], ddl: `CREATE TABLE mt.events (tenant_id integer, id bigint, kind ${kind} NOT NULL, PRIMARY KEY (tenant_id, id))` });
    await apply(writeBuild("events-v1.json", [MT, events("varchar(20)")]));
    await admin!.query("INSERT INTO mt.events SELECT g % 4, g, CASE WHEN g % 2 = 0 THEN 'click' ELSE 'view' END FROM generate_series(1, 1000) g");
    writeBuild("events-v2.json", [MT, events("varchar(10)")]);
    const runs = await runToEnd(config({ name: "migrate-events-kind", table: "mt.events", column: "kind", output: "events-v2.json", batchSize: 300 }));
    expect(runs.map((r) => r.status)).toEqual(["gated", "gated", "ok"]);
    expect(runOutcome(runs[0]!, "Filled")).toBe(4);
    expect(runOutcome(runs[0]!, "BackfilledRows")).toBe(1000);
    expect(await one("SELECT pg_catalog.format_type(atttypid, atttypmod) AS t FROM pg_catalog.pg_attribute WHERE attrelid = 'mt.events'::regclass AND attname = 'kind'")).toEqual({ t: "character varying(10)" });
    expect((await plan("events-v2.json")).changes).toEqual([]);
  }, 300_000);

  test("a text key: a rename", async () => {
    const TX = schemaObj("tx");
    const codes = (col: string): Obj => ({ export: "codes", type: "Postgres::Table", dependsOn: ["tx"], ddl: `CREATE TABLE tx.codes (code text PRIMARY KEY,\n  ${col}\n)` });
    await apply(writeBuild("codes-v1.json", [TX, codes("label text")]));
    await admin!.query("INSERT INTO tx.codes SELECT 'c' || g, 'L' || g FROM generate_series(1, 700) g");
    writeBuild("codes-v2.json", [TX, codes("title text -- previously: label")]);
    const runs = await runToEnd(config({ name: "migrate-codes-title", table: "tx.codes", column: "title", output: "codes-v2.json", batchSize: 250 }));
    expect(runs.map((r) => r.status)).toEqual(["gated", "gated", "ok"]);
    expect(runOutcome(runs[0]!, "Filled")).toBe(3);
    expect(await one("SELECT count(*)::int AS n FROM tx.codes WHERE title = 'L' || substr(code, 2)")).toEqual({ n: 700 });
    expect((await plan("codes-v2.json")).changes).toEqual([]);
  }, 300_000);
});
