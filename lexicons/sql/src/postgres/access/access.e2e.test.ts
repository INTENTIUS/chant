/**
 * Access against a live server (#3681): a declared role, a table with
 * row-level security and a policy, grants on a schema, a table, a column and
 * a function, a revoke from PUBLIC, and default privileges, applied where the
 * profile manages access; then a grant and a revoke made by hand are drift
 * the plan reports and an apply undoes; a profile that does not manage access
 * plans none of it; and an import writes the access back as declarations.
 *
 * The server: `CHANT_SQL_E2E_POSTGRES_URL` (a `postgres://user@host:port/db`
 * URL, with `CHANT_SQL_E2E_POSTGRES_PASSWORD`) names a running one, such as
 * the one `chant emulator up --lexicon sql` starts. Without it, a throwaway
 * server at the pin, skipped cleanly when Docker is not available. The test
 * writes only to the schema `chant_e2e_3681` and the roles
 * `chant_e2e_3681_reader` and `chant_e2e_3681_writer`, all dropped afterwards.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { dockerAvailable, startTestPostgres, type TestPostgres } from "../testing/server";
import { connectPostgres, type PostgresClient, type PostgresEndpoint } from "../live/client";
import { readLiveSchema } from "../live/catalog";
import { planPgAgainstServer } from "../plan/commands";
import { postgresApply } from "../../op/activities/postgres-apply";
import { objectsToIR } from "../import/ir";
import { PostgresGenerator } from "../import/generator";
import { importedAccess } from "./import";

const S = "chant_e2e_3681";
const READER = "chant_e2e_3681_reader";
const WRITER = "chant_e2e_3681_writer";
const given = process.env.CHANT_SQL_E2E_POSTGRES_URL;
const enabled = given ? true : await dockerAvailable();
const dir = mkdtempSync(join(tmpdir(), "chant-pg-access-"));
let server: TestPostgres | undefined;
let endpoint: PostgresEndpoint;
let admin: PostgresClient;

const cleanup = async () => {
  await admin.query(`DROP SCHEMA IF EXISTS ${S} CASCADE`);
  for (const r of [READER, WRITER]) await admin.query(`DROP ROLE IF EXISTS ${r}`);
};

beforeAll(async () => {
  if (!enabled) return;
  if (given) endpoint = { url: given, password: process.env.CHANT_SQL_E2E_POSTGRES_PASSWORD ?? "" };
  else {
    server = await startTestPostgres();
    endpoint = server.endpoint();
  }
  admin = await connectPostgres(endpoint);
  await cleanup();
  // The writer is the environment's: provisioned outside the declarations, only named in them.
  await admin.query(`CREATE ROLE ${WRITER} NOLOGIN`);
}, 600_000);

afterAll(async () => {
  if (enabled) {
    await cleanup().catch(() => undefined);
    await admin?.end();
  }
  await server?.stop();
  rmSync(dir, { recursive: true, force: true });
});

const MARKER = { stack: "e2e3681", env: "test" };
const profile = (access: boolean) => ({
  config: { ownership: MARKER, sql: { profiles: { e2e: { url: endpoint.url, password: { env: "PG_E2E_PASSWORD" }, schemas: [S], ...(access ? { access: true } : {}) } } } },
  env: { PG_E2E_PASSWORD: endpoint.password ?? "" },
});

interface Obj {
  export: string;
  type: string;
  ddl: string;
  dependsOn?: string[];
}

const OBJECTS: Obj[] = [
  { export: "app", type: "Postgres::Schema", ddl: `CREATE SCHEMA ${S}` },
  { export: "reader", type: "Postgres::Role", ddl: `CREATE ROLE ${READER} NOLOGIN` },
  {
    export: "orders",
    type: "Postgres::Table",
    dependsOn: ["app"],
    ddl: `CREATE TABLE ${S}.orders (id bigint PRIMARY KEY, tenant text NOT NULL, note varchar(40));\nALTER TABLE ${S}.orders ENABLE ROW LEVEL SECURITY`,
  },
  {
    export: "ordersTenant",
    type: "Postgres::Policy",
    dependsOn: ["orders", "reader"],
    ddl: `CREATE POLICY orders_tenant ON ${S}.orders FOR SELECT TO ${READER} USING (tenant = current_setting('app.tenant', true) AND note <> 'hidden')`,
  },
  { export: "total", type: "Postgres::Function", dependsOn: ["app"], ddl: `CREATE FUNCTION ${S}.total() RETURNS bigint LANGUAGE sql AS 'SELECT 1::bigint'` },
  { export: "useApp", type: "Postgres::Grant", dependsOn: ["app", "reader"], ddl: `GRANT USAGE ON SCHEMA ${S} TO ${READER}` },
  { export: "readOrders", type: "Postgres::Grant", dependsOn: ["orders", "reader"], ddl: `GRANT SELECT ON ${S}.orders TO ${READER}` },
  { export: "writeNote", type: "Postgres::Grant", dependsOn: ["orders"], ddl: `GRANT UPDATE (note) ON ${S}.orders TO ${WRITER}` },
  { export: "totalPrivate", type: "Postgres::Grant", dependsOn: ["total"], ddl: `REVOKE EXECUTE ON FUNCTION ${S}.total() FROM PUBLIC` },
  { export: "totalReader", type: "Postgres::Grant", dependsOn: ["total", "reader"], ddl: `GRANT EXECUTE ON FUNCTION ${S}.total() TO ${READER}` },
  { export: "readNewTables", type: "Postgres::DefaultPrivileges", dependsOn: ["app", "reader"], ddl: `ALTER DEFAULT PRIVILEGES IN SCHEMA ${S} GRANT SELECT ON TABLES TO ${READER}` },
];

function writeBuild(file: string, objects: Obj[]): string {
  const path = join(dir, file);
  writeFileSync(path, JSON.stringify({ dialect: "postgres", postgresMajor: 18, objects: objects.map((o) => ({ dependsOn: [], ...o })) }));
  return path;
}

const apply = (path: string, access = true) => postgresApply({ buildPath: path, environment: "e2e" }, undefined, { ...profile(access), log: () => undefined });
const plan = (path: string, access = true) => planPgAgainstServer("e2e", path, profile(access));
const rules = async (path: string) => (await plan(path)).changes.map((c) => [c.object, c.rule]);

describe.skipIf(!enabled)("access on a live server", () => {
  test("applied, then drift by hand reported and undone, unmanaged left alone, imported back", async () => {
    const build = writeBuild("v1.json", OBJECTS);

    // A profile that does not manage access: the access declarations are filtered, the table is created without row-level security.
    const off = await apply(build, false);
    expect(off.failed).toEqual([]);
    expect(off.notAttempted.map((n) => n.reason)).toEqual(Array(8).fill("filtered"));
    expect(off.notAttempted).toHaveLength(8);
    expect((await admin.query<{ rls: boolean }>(`SELECT relrowsecurity AS rls FROM pg_class WHERE oid = '${S}.orders'::regclass`))[0]!.rls).toBe(false);
    const unmanaged = await plan(build, false);
    expect(unmanaged.changes).toEqual([]);
    expect(unmanaged.hints.join(" ")).toContain("9 access declarations are not planned");

    // Managed: every access declaration applied.
    expect(await rules(build)).toEqual([
      [`reader (${READER})`, "SQLPG200"],
      [`orders (${S}.orders)`, "SQLPG293"],
      [`ordersTenant (${S}.orders_tenant ON ${S}.orders)`, "SQLPG290"],
      [`default privileges in ${S} on tables TO ${READER}`, "SQLPG298"],
      [`relation ${S}.orders (note) TO ${WRITER}`, "SQLPG296"],
      [`relation ${S}.orders TO ${READER}`, "SQLPG296"],
      [`routine ${S}.total() TO PUBLIC`, "SQLPG297"],
      [`routine ${S}.total() TO ${READER}`, "SQLPG296"],
      [`schema ${S} TO ${READER}`, "SQLPG296"],
    ]);
    const on = await apply(build);
    expect(on.failed).toEqual([]);
    expect(on.applied.map((a) => [a.name, a.action])).toEqual([
      [S, "unchanged"],
      [`${S}.total()`, "unchanged"],
      [READER, "created"],
      [`${S}.orders`, "updated"],
      [`orders_tenant ON ${S}.orders`, "created"],
      [`grant usage on schema ${S} to ${READER}`, "updated"],
      [`grant select on table ${S}.orders to ${READER}`, "updated"],
      [`grant update(note) on table ${S}.orders to ${WRITER}`, "updated"],
      [`revoke execute on function ${S}.total() from public`, "updated"],
      [`grant execute on function ${S}.total() to ${READER}`, "updated"],
      [`default privileges grant select on tables in ${S} to ${READER}`, "updated"],
    ]);
    expect(await rules(build)).toEqual([]);
    const can = async (sql: string) => (await admin.query<{ ok: boolean }>(sql))[0]!.ok;
    expect(await can(`SELECT has_table_privilege('${READER}', '${S}.orders', 'SELECT') AS ok`)).toBe(true);
    expect(await can(`SELECT has_column_privilege('${WRITER}', '${S}.orders', 'note', 'UPDATE') AS ok`)).toBe(true);
    expect(await can(`SELECT has_function_privilege('public', '${S}.total()', 'EXECUTE') AS ok`)).toBe(false);
    expect(await can(`SELECT relrowsecurity AS ok FROM pg_class WHERE oid = '${S}.orders'::regclass`)).toBe(true);

    // By hand: a grant nobody declared, and a declared grant revoked. The plan reports both; an apply undoes both.
    await admin.query(`GRANT INSERT ON ${S}.orders TO ${WRITER}`);
    await admin.query(`REVOKE SELECT ON ${S}.orders FROM ${READER}`);
    expect(await rules(build)).toEqual([
      [`relation ${S}.orders TO ${READER}`, "SQLPG296"],
      [`relation ${S}.orders TO ${WRITER}`, "SQLPG297"],
    ]);
    const undo = await apply(build);
    expect(undo.failed).toEqual([]);
    expect(undo.statements.map((s) => s.sql)).toEqual(expect.arrayContaining([`GRANT SELECT ON TABLE ${S}.orders TO ${READER}`, `REVOKE INSERT ON TABLE ${S}.orders FROM ${WRITER}`]));
    expect(await rules(build)).toEqual([]);

    // A policy changed by hand is drift too.
    await admin.query(`ALTER POLICY orders_tenant ON ${S}.orders USING (true)`);
    expect(await rules(build)).toEqual([[`ordersTenant (${S}.orders_tenant ON ${S}.orders)`, "SQLPG291"]]);
    await apply(build);
    expect(await rules(build)).toEqual([]);

    // Import: the policy and the row-level security with the table, the privileges as grant declarations.
    const live = await readLiveSchema(admin, { schemas: [S], access: true });
    const access = await importedAccess(admin, live, [S]);
    const [file] = new PostgresGenerator().generate(objectsToIR([...live.map((o) => ({ type: o.type, schema: o.schema, name: o.name, ddl: o.statement })), ...access]));
    expect(file!.content).toContain("export const ordersTenant = policy`");
    expect(file!.content).toContain(`ALTER TABLE \${chantE2e3681Schema}.orders ENABLE ROW LEVEL SECURITY`);
    expect(file!.content).toContain(`GRANT SELECT ON TABLE \${orders} TO ${READER}`);
    expect(file!.content).toContain(`REVOKE EXECUTE ON FUNCTION \${total}() FROM PUBLIC`);
    expect(file!.content).toContain(`ALTER DEFAULT PRIVILEGES IN SCHEMA \${chantE2e3681Schema} GRANT SELECT ON TABLES TO ${READER}`);
    expect(file!.content).toContain(`GRANT USAGE ON SCHEMA \${chantE2e3681Schema} TO ${READER}`);
  }, 600_000);
});
