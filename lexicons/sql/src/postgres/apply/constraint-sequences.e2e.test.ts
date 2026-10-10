/**
 * A CHECK or a foreign key added to a table that exists, against a live
 * server (#3703).
 *
 * - The applier adds each one NOT VALID, then validates it in a transaction
 *   of its own, and both end valid.
 * - Step by step, each statement's transaction held open: a concurrent
 *   writer is not blocked while VALIDATE reads the 200,000 rows, and the
 *   probe is shown to detect locks by being blocked during the NOT VALID add.
 * - A run that stopped after the NOT VALID add resumes at VALIDATE.
 *
 * The server: `CHANT_SQL_E2E_POSTGRES_URL` (with
 * `CHANT_SQL_E2E_POSTGRES_PASSWORD`) names a running one, else a throwaway
 * server at the pin, skipped when Docker is not available. The test writes
 * only to the schema `chant_e2e_3703`, dropped afterwards.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { dockerAvailable, startTestPostgres, type TestPostgres } from "../testing/server";
import { connectPostgres, type PostgresClient, type PostgresEndpoint } from "../live/client";
import { postgresApply } from "../../op/activities/postgres-apply";
import { diffStatements, type StatementStep } from "../../migration-statements";

const S = "chant_e2e_3703";
const given = process.env.CHANT_SQL_E2E_POSTGRES_URL;
const enabled = given ? true : await dockerAvailable();
const dir = mkdtempSync(join(tmpdir(), "chant-pg-constraints-"));
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

const doc = (objects: Obj[]) => ({ dialect: "postgres", postgresMajor: 18, objects: objects.map((o) => ({ dependsOn: [], ...o })) });
const schema: Obj = { export: "app", type: "Postgres::Schema", ddl: `CREATE SCHEMA ${S}` };
const parents: Obj = { export: "parents", type: "Postgres::Table", dependsOn: ["app"], ddl: `CREATE TABLE ${S}.parents (id bigint PRIMARY KEY)` };
/** `items` with the constraints named in `with` declared. */
const items = (...with_: Array<"pos" | "fk" | "small">): Obj => ({
  export: "items",
  type: "Postgres::Table",
  dependsOn: ["app", "parents"],
  ddl: [
    `CREATE TABLE ${S}.items (id bigint PRIMARY KEY, n int, parent bigint`,
    with_.includes("pos") ? ", CONSTRAINT items_n_pos CHECK (n > 0)" : "",
    with_.includes("fk") ? `, CONSTRAINT items_parent_fkey FOREIGN KEY (parent) REFERENCES ${S}.parents (id)` : "",
    with_.includes("small") ? ", CONSTRAINT items_n_small CHECK (n < 1000000)" : "",
    ")",
  ].join(""),
});

function writeBuild(file: string, objects: Obj[]): string {
  const path = join(dir, file);
  writeFileSync(path, JSON.stringify(doc(objects)));
  return path;
}

const profile = () => ({
  config: { ownership: { stack: "e2e3703", env: "test" }, sql: { profiles: { e2e: { url: endpoint.url, password: { env: "PG_E2E_PASSWORD" }, schemas: [S] } } } },
  env: { PG_E2E_PASSWORD: endpoint.password ?? "" },
});
const apply = (path: string) => postgresApply({ buildPath: path, environment: "e2e" }, undefined, { ...profile(), log: () => undefined });
const validated = async (name: string) =>
  (await admin.query<{ v: boolean }>(`SELECT convalidated AS v FROM pg_constraint WHERE conrelid = '${S}.items'::regclass AND conname = '${name}'`))[0]?.v;

/** A raw node-postgres session, for holding a transaction open. */
async function session(): Promise<pg.Client> {
  const url = new URL(endpoint.url);
  if (endpoint.password !== undefined) url.password = encodeURIComponent(endpoint.password);
  const c = new pg.Client({ connectionString: url.toString() });
  c.on("error", () => undefined);
  await c.connect();
  return c;
}

describe.skipIf(!enabled)("a CHECK and a foreign key added NOT VALID, then validated, on a live server", () => {
  beforeAll(async () => {
    const first = await apply(writeBuild("v1.json", [schema, parents, items()]));
    expect(first.failed).toEqual([]);
    await admin.query(`INSERT INTO ${S}.parents SELECT g FROM generate_series(1, 200000) g`);
    await admin.query(`INSERT INTO ${S}.items (id, n, parent) SELECT g, g, g FROM generate_series(1, 200000) g`);
  }, 120_000);

  test("the applier sends ADD ... NOT VALID, then VALIDATE in a transaction of its own, and both end valid", async () => {
    const out = await apply(writeBuild("v2.json", [schema, parents, items("pos", "fk")]));
    expect(out.failed).toEqual([]);
    const mine = out.statements.filter((s) => /items_n_pos|items_parent_fkey/.test(s.sql));
    expect(mine.map((s) => [s.sql, s.class])).toEqual([
      [`ALTER TABLE ${S}.items ADD CONSTRAINT items_n_pos CHECK (n > 0) NOT VALID`, "metadata"],
      [`ALTER TABLE ${S}.items VALIDATE CONSTRAINT items_n_pos`, "validate"],
      [`ALTER TABLE ${S}.items ADD CONSTRAINT items_parent_fkey FOREIGN KEY (parent) REFERENCES ${S}.parents (id) NOT VALID`, "metadata"],
      [`ALTER TABLE ${S}.items VALIDATE CONSTRAINT items_parent_fkey`, "validate"],
    ]);
    const [addCheck, validateCheck, addFk, validateFk] = mine.map((s) => s.transaction);
    expect(validateCheck).not.toBe(addCheck);
    expect(validateCheck).not.toBe(addFk);
    expect(validateFk).not.toBe(addFk);
    expect(await validated("items_n_pos")).toBe(true);
    expect(await validated("items_parent_fkey")).toBe(true);
  }, 120_000);

  test("a concurrent writer is not blocked while VALIDATE reads the table", async () => {
    await admin.query(`ALTER TABLE ${S}.items DROP CONSTRAINT items_parent_fkey`);
    const before = doc([schema, parents, items("pos")]);
    const steps = diffStatements(before, doc([schema, parents, items("pos", "fk", "small")])).steps.filter((s): s is StatementStep => s.kind === "statement");
    expect(steps.map((s) => [s.rule, s.class])).toEqual([
      ["SQLPG217", "metadata"],
      ["SQLPG220", "validate"],
      ["SQLPG217", "metadata"],
      ["SQLPG220", "validate"],
    ]);
    for (const s of steps.filter((s) => s.precheck)) expect((await admin.query<{ n: string }>(s.precheck!.sql))[0]!.n, s.sql).toBe("0");

    const applier = await session();
    const writer = await session();
    try {
      await writer.query("SET lock_timeout = '300ms'");
      let id = 1_000_000;
      for (const s of steps) {
        await applier.query("BEGIN");
        await applier.query(s.sql);
        // The applier's transaction is open: does a write to the table wait for it?
        const blocked = await writer.query(`INSERT INTO ${S}.items (id, n, parent) VALUES (${id++}, 1, 1)`).then(
          () => false,
          (e: { code?: string }) => e.code === "55P03",
        );
        await applier.query("COMMIT");
        // VALIDATE reads every row, and the writer goes on.
        if (s.class === "validate") expect(blocked, s.sql).toBe(false);
        // The probe sees a lock: the NOT VALID add does hold the writer while its transaction is open.
        else expect(blocked, s.sql).toBe(true);
      }
    } finally {
      await applier.end();
      await writer.end();
    }
    expect(await validated("items_parent_fkey")).toBe(true);
    expect(await validated("items_n_small")).toBe(true);
  }, 120_000);

  test("a run that stopped after the NOT VALID add resumes at VALIDATE", async () => {
    await admin.query(`ALTER TABLE ${S}.items DROP CONSTRAINT items_n_small`);
    // The run stopped after its first statement.
    await admin.query(`ALTER TABLE ${S}.items ADD CONSTRAINT items_n_small CHECK (n < 1000000) NOT VALID`);
    expect(await validated("items_n_small")).toBe(false);
    const out = await apply(writeBuild("v3.json", [schema, parents, items("pos", "fk", "small")]));
    expect(out.failed).toEqual([]);
    expect(out.statements.filter((s) => s.sql.includes("items_n_small")).map((s) => [s.sql, s.class])).toEqual([[`ALTER TABLE ${S}.items VALIDATE CONSTRAINT items_n_small`, "validate"]]);
    expect(await validated("items_n_small")).toBe(true);
  }, 120_000);
});
