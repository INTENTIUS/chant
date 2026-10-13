/**
 * Lock-safe SET NOT NULL and the pre-checks against a live server (#3686).
 *
 * - The applier makes SET NOT NULL as a NOT VALID check, its validation in a
 *   transaction of its own, SET NOT NULL and the check dropped, and leaves no
 *   check behind.
 * - Step by step, each statement's transaction held open: a concurrent
 *   writer is not blocked while the validation reads the table, and SET NOT
 *   NULL is proven by the check without a scan (the server says so at
 *   DEBUG1).
 * - Each kind of pre-check runs on the server and counts what its statement
 *   would fail on: NULLs, duplicates, rows a check refuses, orphans.
 *
 * The server: `CHANT_SQL_E2E_POSTGRES_URL` (with
 * `CHANT_SQL_E2E_POSTGRES_PASSWORD`) names a running one, else a throwaway
 * server at the pin, skipped when Docker is not available. The test writes
 * only to the schema `chant_e2e_3686`, dropped afterwards.
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

const S = "chant_e2e_3686";
const given = process.env.CHANT_SQL_E2E_POSTGRES_URL;
const enabled = given ? true : await dockerAvailable();
const dir = mkdtempSync(join(tmpdir(), "chant-pg-safe-"));
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
const items = (cols: { a?: boolean; b?: boolean }): Obj => ({
  export: "items",
  type: "Postgres::Table",
  dependsOn: ["app"],
  ddl: `CREATE TABLE ${S}.items (id bigint PRIMARY KEY, a text${cols.a ? " NOT NULL" : ""}, b text${cols.b ? " NOT NULL" : ""}, c text, parent bigint)`,
});

function writeBuild(file: string, objects: Obj[]): string {
  const path = join(dir, file);
  writeFileSync(path, JSON.stringify(doc(objects)));
  return path;
}

const profile = () => ({
  config: { ownership: { stack: "e2e3686", env: "test" }, sql: { profiles: { e2e: { url: endpoint.url, password: { env: "PG_E2E_PASSWORD" }, schemas: [S] } } } },
  env: { PG_E2E_PASSWORD: endpoint.password ?? "" },
});
const apply = (path: string) => postgresApply({ buildPath: path, environment: "e2e" }, undefined, { ...profile(), log: () => undefined });

/** A raw node-postgres session, for holding a transaction open and reading the server's notices. */
async function session(): Promise<pg.Client> {
  const url = new URL(endpoint.url);
  if (endpoint.password !== undefined) url.password = encodeURIComponent(endpoint.password);
  const c = new pg.Client({ connectionString: url.toString() });
  c.on("error", () => undefined);
  await c.connect();
  return c;
}

describe.skipIf(!enabled)("lock-safe SET NOT NULL on a live server", () => {
  beforeAll(async () => {
    const first = await apply(writeBuild("v1.json", [schema, items({})]));
    expect(first.failed).toEqual([]);
    await admin.query(`INSERT INTO ${S}.items (id, a, b, c, parent) SELECT g, 'a', 'b', CASE WHEN g = 7 THEN NULL ELSE 'c' END, g FROM generate_series(1, 200000) g`);
  }, 120_000);

  test("the applier sends the four statements, validating in a transaction of its own, and leaves no check", async () => {
    const out = await apply(writeBuild("v2.json", [schema, items({ a: true })]));
    expect(out.failed).toEqual([]);
    const mine = out.statements.filter((s) => s.sql.includes("a__chant_nn") || s.sql.includes("COLUMN a "));
    expect(mine.map((s) => [s.sql, s.class])).toEqual([
      [`ALTER TABLE ${S}.items ADD CONSTRAINT a__chant_nn CHECK (a IS NOT NULL) NOT VALID`, "metadata"],
      [`ALTER TABLE ${S}.items VALIDATE CONSTRAINT a__chant_nn`, "validate"],
      [`ALTER TABLE ${S}.items ALTER COLUMN a SET NOT NULL`, "metadata"],
      [`ALTER TABLE ${S}.items DROP CONSTRAINT a__chant_nn`, "metadata"],
    ]);
    const [add, validate, set] = mine.map((s) => s.transaction);
    expect(validate).not.toBe(add);
    expect(validate).not.toBe(set);
    const [col] = await admin.query<{ notnull: boolean }>(`SELECT attnotnull AS notnull FROM pg_attribute WHERE attrelid = '${S}.items'::regclass AND attname = 'a'`);
    expect(col?.notnull).toBe(true);
    expect(await admin.query(`SELECT 1 FROM pg_constraint WHERE conrelid = '${S}.items'::regclass AND conname = 'a__chant_nn'`)).toEqual([]);
  }, 120_000);

  test("a concurrent writer is not blocked while the table is validated, and SET NOT NULL does not scan", async () => {
    const d = diffStatements(doc([schema, items({ a: true })]), doc([schema, items({ a: true, b: true })]));
    const steps = d.steps.filter((s): s is StatementStep => s.kind === "statement");
    expect(steps.map((s) => s.class)).toEqual(["metadata", "validate", "metadata", "metadata"]);
    expect((await admin.query<{ n: string }>(steps[0]!.precheck!.sql))[0]!.n).toBe("0");

    const applier = await session();
    const writer = await session();
    const notices: string[] = [];
    applier.on("notice", (n) => notices.push(n.message ?? ""));
    try {
      await writer.query("SET lock_timeout = '300ms'");
      let id = 1_000_000;
      for (const s of steps) {
        await applier.query("BEGIN");
        await applier.query(s.sql.includes("SET NOT NULL") ? "SET LOCAL client_min_messages = debug1" : "SET LOCAL client_min_messages = notice");
        await applier.query(s.sql);
        // The applier's transaction is open: does a write to the table wait for it?
        const blocked = await writer.query(`INSERT INTO ${S}.items (id, a, b, c) VALUES (${id++}, 'a', 'b', 'c')`).then(
          () => false,
          (e: { code?: string }) => e.code === "55P03",
        );
        await applier.query("COMMIT");
        if (s.class === "validate") expect(blocked, s.sql).toBe(false);
        // The probe sees a lock: the brief catalog change does hold the writer while its transaction is open.
        if (s.rule === "SQLPG217") expect(blocked, s.sql).toBe(true);
      }
    } finally {
      await applier.end();
      await writer.end();
    }
    expect(notices.some((m) => /sufficient to prove that it does not contain nulls/.test(m))).toBe(true);
  }, 120_000);

  test("each pre-check counts what its statement would fail on", async () => {
    // c is NULL in one row; a holds one value in every row; one row has id 7; parent 1 is not a parent.
    await admin.query(`CREATE TABLE ${S}.parents (id bigint PRIMARY KEY)`);
    await admin.query(`INSERT INTO ${S}.parents SELECT g FROM generate_series(2, 200000) g`);
    const after = (ddl: string, extra: Obj[] = []) => doc([schema, { ...items({ a: true, b: true }), ddl }, ...extra]);
    const before = doc([schema, items({ a: true, b: true }), { export: "parents", type: "Postgres::Table", dependsOn: ["app"], ddl: `CREATE TABLE ${S}.parents (id bigint PRIMARY KEY)` }]);
    const base = items({ a: true, b: true }).ddl;
    const parents: Obj = { export: "parents", type: "Postgres::Table", dependsOn: ["app"], ddl: `CREATE TABLE ${S}.parents (id bigint PRIMARY KEY)` };
    const cases: Array<[string, ReturnType<typeof doc>, string]> = [
      ["SET NOT NULL", after(base.replace("c text", "c text NOT NULL"), [parents]), "1"],
      ["UNIQUE", after(base.replace(", parent bigint)", ", parent bigint, CONSTRAINT items_a_key UNIQUE (a))"), [parents]), "1"],
      ["UNIQUE over id", after(base.replace(", parent bigint)", ", parent bigint, CONSTRAINT items_id_key UNIQUE (id))"), [parents]), "0"],
      ["CHECK", after(base.replace(", parent bigint)", ", parent bigint, CONSTRAINT not_seven CHECK (id <> 7))"), [parents]), "1"],
      ["FOREIGN KEY", after(base.replace("parent bigint", `parent bigint CONSTRAINT items_parent_fkey REFERENCES ${S}.parents (id)`), [parents]), "1"],
    ];
    for (const [what, next, n] of cases) {
      const step = diffStatements(before, next).steps.find((s): s is StatementStep => s.kind === "statement" && s.precheck !== undefined);
      expect(step, what).toBeDefined();
      expect((await admin.query<{ n: string }>(step!.precheck!.sql))[0]!.n, what).toBe(n);
    }
  }, 120_000);
});
