/**
 * Functions, procedures and triggers against a live server (#3680): applied
 * as declared, they plan with no change and read back with no drift; a body,
 * a result type and a trigger's condition changed in the declaration are
 * planned with their rules and applied; a function replaced by hand is
 * drift; and an import writes them back as `func`, `procedure` and
 * `trigger` declarations that parse.
 *
 * The server: `CHANT_SQL_E2E_POSTGRES_URL` (a `postgres://user@host:port/db`
 * URL, with `CHANT_SQL_E2E_POSTGRES_PASSWORD`) names a running one, such as
 * the one `chant emulator up --lexicon sql` starts. Without it, a throwaway
 * server at the pin, skipped cleanly when Docker is not available. The test
 * writes only to the schema `chant_e2e_3680`, dropped afterwards.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { dockerAvailable, startTestPostgres, type TestPostgres } from "../testing/server";
import { connectPostgres, type PostgresClient, type PostgresEndpoint } from "./client";
import { readLiveSchema } from "./catalog";
import { planPgAgainstServer } from "../plan/commands";
import { observeResourcesDeep } from "../plan/deep";
import { postgresApply } from "../../op/activities/postgres-apply";
import { objectsToIR } from "../import/ir";
import { PostgresGenerator } from "../import/generator";
import { liveProps } from "../plan/deep";
import { declaredObjects } from "../apply/apply";

const SCHEMA = "chant_e2e_3680";
const given = process.env.CHANT_SQL_E2E_POSTGRES_URL;
const enabled = given ? true : await dockerAvailable();
const dir = mkdtempSync(join(tmpdir(), "chant-pg-routines-"));
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
  await admin.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
}, 600_000);

afterAll(async () => {
  if (enabled) {
    await admin?.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`).catch(() => undefined);
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

const MARKER = { stack: "e2e3680", env: "test" };
const profile = () => ({
  config: { ownership: MARKER, sql: { profiles: { e2e: { url: endpoint.url, password: { env: "PG_E2E_PASSWORD" }, schemas: [SCHEMA] } } } },
  env: { PG_E2E_PASSWORD: endpoint.password ?? "" },
});

function writeBuild(file: string, objects: Obj[]): string {
  const path = join(dir, file);
  writeFileSync(path, JSON.stringify({ dialect: "postgres", postgresMajor: 18, objects: objects.map((o) => ({ dependsOn: [], ...o })) }));
  return path;
}

const apply = (path: string) => postgresApply({ buildPath: path, environment: "e2e" }, undefined, { ...profile(), log: () => undefined });
const plan = (path: string) => planPgAgainstServer("e2e", path, profile());

const S = SCHEMA;
const objects = (v: { body: string; totalReturns: string; when: string }): Obj[] => [
  { export: "app", type: "Postgres::Schema", ddl: `CREATE SCHEMA ${S}` },
  {
    export: "orders",
    type: "Postgres::Table",
    dependsOn: ["app"],
    ddl: `CREATE TABLE ${S}.orders (id bigint PRIMARY KEY, status text NOT NULL, amount numeric(12,2), note varchar(40), updated_at timestamptz)`,
  },
  {
    export: "touch",
    type: "Postgres::Function",
    dependsOn: ["app"],
    ddl: `CREATE FUNCTION ${S}.touch() RETURNS trigger LANGUAGE plpgsql SET search_path = ${S} AS $$\nBEGIN\n  ${v.body}\n  RETURN NEW;\nEND\n$$;\nCOMMENT ON FUNCTION ${S}.touch() IS 'Stamps updated_at'`,
  },
  {
    export: "total",
    type: "Postgres::Function",
    dependsOn: ["orders"],
    ddl: `CREATE FUNCTION ${S}.total(min_amount numeric DEFAULT 0, label varchar(10) = 'all') RETURNS ${v.totalReturns} LANGUAGE sql STABLE PARALLEL SAFE AS $$ SELECT coalesce(sum(amount), 0)::${v.totalReturns} FROM ${S}.orders WHERE amount >= min_amount $$`,
  },
  {
    export: "archive",
    type: "Postgres::Procedure",
    dependsOn: ["orders"],
    ddl: `CREATE PROCEDURE ${S}.archive(IN before_id bigint, INOUT archived int DEFAULT NULL) LANGUAGE plpgsql AS $$ BEGIN DELETE FROM ${S}.orders WHERE id < before_id; GET DIAGNOSTICS archived = ROW_COUNT; END $$`,
  },
  {
    export: "ordersTouch",
    type: "Postgres::Trigger",
    dependsOn: ["orders", "touch"],
    ddl: `CREATE TRIGGER orders_touch BEFORE INSERT OR UPDATE OF status, note ON ${S}.orders FOR EACH ROW WHEN (${v.when}) EXECUTE FUNCTION ${S}.touch('x', 1)`,
  },
];

const V1 = { body: "NEW.updated_at := now();", totalReturns: "numeric", when: "NEW.note IS DISTINCT FROM 'skip'" };
const V2 = { body: "NEW.updated_at := clock_timestamp();", totalReturns: "double precision", when: "NEW.note <> 'skip' AND NEW.status = 'open'" };

describe.skipIf(!enabled)("functions, procedures and triggers on a live server", () => {
  test("apply, plan, drift, change and import", async () => {
    const v1 = writeBuild("v1.json", objects(V1));
    const first = await apply(v1);
    expect(first.failed).toEqual([]);
    expect(first.applied.map((a) => [a.name, a.action])).toEqual([
      [S, "created"],
      [`${S}.orders`, "created"],
      [`${S}.touch()`, "created"],
      [`${S}.total(numeric,character varying)`, "created"],
      [`${S}.archive(bigint,integer)`, "created"],
      [`orders_touch ON ${S}.orders`, "created"],
    ]);
    // The trigger fires, with its WHEN and its arguments.
    await admin.query(`INSERT INTO ${S}.orders (id, status, amount) VALUES (1, 'open', 10), (2, 'open', 5)`);
    expect((await admin.query<{ n: string }>(`SELECT count(*) AS n FROM ${S}.orders WHERE updated_at IS NOT NULL`))[0]!.n).toBe("2");

    // As declared: no change, and no drift, the WHEN the server prints with its casts included.
    expect((await plan(v1)).changes).toEqual([]);
    const declared = declaredObjects(JSON.stringify({ dialect: "postgres", objects: objects(V1).map((o) => ({ dependsOn: [], ...o })) }));
    const entities = new Map(declared.map((o) => [o.exportName, { entityType: o.type, props: o.props }]));
    const deep = await observeResourcesDeep({ environment: "e2e", entityNames: [...entities.keys()], entities, ...profile() });
    expect(deep.unobserved ?? {}).toEqual({});
    const strip = (p: Record<string, unknown>) => Object.fromEntries(Object.entries(p).filter(([k]) => !["ddl", "source", "reads", "orReplace"].includes(k)));
    for (const [name, e] of entities) expect(strip(deep.resources[name]!.properties), name).toEqual(strip(e.props));

    // Replaced by hand: drift, in the plan and in the deep read.
    await admin.query(`CREATE OR REPLACE FUNCTION ${S}.touch() RETURNS trigger LANGUAGE plpgsql SET search_path = ${S} AS $$ BEGIN RETURN NEW; END $$`);
    expect((await plan(v1)).changes.map((c) => [c.object, c.field, c.rule])).toEqual([[`touch (${S}.touch())`, "body", "SQLPG280"]]);
    const drifted = await observeResourcesDeep({ environment: "e2e", entityNames: ["touch"], entities, ...profile() });
    expect(drifted.resources.touch!.properties.body).toBe(" BEGIN RETURN NEW; END ");

    // Changed in the declaration: a body (OR REPLACE), a result type (drop and create), a trigger's condition (OR REPLACE).
    const v2 = writeBuild("v2.json", objects(V2));
    expect((await plan(v2)).changes.map((c) => [c.object, c.rule])).toEqual([
      [`touch (${S}.touch())`, "SQLPG280"],
      [`total (${S}.total(numeric,character varying))`, "SQLPG281"],
      [`ordersTouch (${S}.orders_touch ON ${S}.orders)`, "SQLPG284"],
    ]);
    const second = await apply(v2);
    expect(second.failed).toEqual([]);
    expect(second.applied.filter((a) => a.action === "updated").map((a) => a.name)).toEqual([`${S}.touch()`, `${S}.total(numeric,character varying)`, `orders_touch ON ${S}.orders`]);
    expect((await plan(v2)).changes).toEqual([]);
    expect((await admin.query<{ c: string }>(`SELECT obj_description('${S}.total(numeric,varchar)'::regprocedure, 'pg_proc') AS c`))[0]!.c).toContain("stack=e2e3680");

    // Import: the server's own printing, written back as declarations that parse.
    const live = await readLiveSchema(admin, { schemas: [S] });
    for (const o of live) liveProps(o);
    const [file] = new PostgresGenerator().generate(objectsToIR(live.map((o) => ({ type: o.type, schema: o.schema, name: o.name, ddl: o.statement }))));
    expect(file!.content).toContain("export const touch = func`");
    expect(file!.content).toContain("export const archive = procedure`");
    expect(file!.content).toContain("export const ordersTouch = trigger`");
    expect(file!.content).toContain("EXECUTE FUNCTION ${touch}('x', '1')");
  }, 600_000);
});
