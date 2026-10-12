/**
 * Composite and range types, aggregates, collations, casts and event
 * triggers against a live server (#3911): applied as declared, they plan
 * with no change and read back with no drift; a definition changed in the
 * declaration is replaced (CREATE OR REPLACE AGGREGATE), dropped and created,
 * or refused while something depends on it; an import writes each back as
 * the declaration it came from, which plans with no change.
 *
 * The server: a throwaway one at the pin, skipped cleanly when Docker is not
 * available. An event trigger is the database's and fires for every DDL in
 * it, so this test does not run against a shared server
 * (`CHANT_SQL_E2E_POSTGRES_URL`).
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { dockerAvailable, startTestPostgres, type TestPostgres } from "../testing/server";
import { connectPostgres, type PostgresClient, type PostgresEndpoint } from "./client";
import { readLiveSchema } from "./catalog";
import { planPgAgainstServer } from "../plan/commands";
import { observeResourcesDeep, liveProps } from "../plan/deep";
import { postgresApply } from "../../op/activities/postgres-apply";
import { objectsToIR } from "../import/ir";
import { PostgresGenerator, postgresTemplates } from "../import/generator";
import { declaredObjects } from "../apply/apply";

const SCHEMA = "chant_e2e_3911";
const enabled = await dockerAvailable();
const dir = mkdtempSync(join(tmpdir(), "chant-pg-kinds-"));
let server: TestPostgres | undefined;
let endpoint: PostgresEndpoint;
let admin: PostgresClient;

beforeAll(async () => {
  if (!enabled) return;
  server = await startTestPostgres();
  endpoint = server.endpoint();
  admin = await connectPostgres(endpoint);
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

const MARKER = { stack: "e2e3911", env: "test" };
const profile = () => ({
  config: { ownership: MARKER, sql: { profiles: { e2e: { url: endpoint.url, password: { env: "PG_E2E_PASSWORD" }, schemas: [SCHEMA] } } } },
  env: { PG_E2E_PASSWORD: endpoint.password ?? "" },
});

function writeBuild(file: string, objects: Obj[]): string {
  const path = join(dir, file);
  writeFileSync(path, JSON.stringify({ dialect: "postgres", postgresMajor: 18, objects: objects.map((o) => ({ dependsOn: [], ...o })) }));
  return path;
}

const apply = (path: string, prune = false) => postgresApply({ buildPath: path, environment: "e2e", ...(prune ? { prune: true } : {}) }, undefined, { ...profile(), log: () => undefined });
const plan = (path: string) => planPgAgainstServer("e2e", path, profile());

const S = SCHEMA;
interface Version {
  /** The composite type's attributes. */
  pair: string;
  /** The aggregate's INITCOND. */
  initcond: string;
  /** The range's SUBTYPE_DIFF clause. */
  diff: string;
  /** The collation's locale. */
  locale: string;
  /** The cast's context. */
  context: string;
  /** The event trigger's tags. */
  tags: string;
}

const objects = (v: Version): Obj[] => [
  { export: "app", type: "Postgres::Schema", ddl: `CREATE SCHEMA ${S}` },
  { export: "ci", type: "Postgres::Collation", dependsOn: ["app"], ddl: `CREATE COLLATION ${S}.ci (provider = icu, locale = '${v.locale}', deterministic = false);\nCOMMENT ON COLLATION ${S}.ci IS 'Case-insensitive'` },
  { export: "pair", type: "Postgres::CompositeType", dependsOn: ["app"], ddl: `CREATE TYPE ${S}.pair AS (${v.pair});\nCOMMENT ON TYPE ${S}.pair IS 'Two values'` },
  { export: "floatrange", type: "Postgres::RangeType", dependsOn: ["app"], ddl: `CREATE TYPE ${S}.floatrange AS RANGE (SUBTYPE = float8${v.diff})` },
  { export: "people", type: "Postgres::Table", dependsOn: ["ci", "floatrange"], ddl: `CREATE TABLE ${S}.people (id int PRIMARY KEY, nick text COLLATE ${S}.ci, span ${S}.floatrange)` },
  { export: "add2", type: "Postgres::Function", dependsOn: ["app"], ddl: `CREATE FUNCTION ${S}.add2(a integer, b integer) RETURNS integer LANGUAGE sql IMMUTABLE AS $$ SELECT a + b $$` },
  {
    export: "total",
    type: "Postgres::Aggregate",
    dependsOn: ["add2"],
    ddl: `CREATE AGGREGATE ${S}.total(integer) (SFUNC = ${S}.add2, STYPE = int4, INITCOND = ${v.initcond}, PARALLEL = SAFE);\nCOMMENT ON AGGREGATE ${S}.total(int) IS 'A sum'`,
  },
  { export: "pairText", type: "Postgres::Function", dependsOn: ["pair"], ddl: `CREATE FUNCTION ${S}.pair_text(p ${S}.pair) RETURNS text LANGUAGE sql IMMUTABLE AS $$ SELECT p.a || ':' || p.b $$` },
  { export: "pairCast", type: "Postgres::Cast", dependsOn: ["pair", "pairText"], ddl: `CREATE CAST (${S}.pair AS text) WITH FUNCTION ${S}.pair_text(${S}.pair)${v.context}` },
  { export: "audit", type: "Postgres::Function", dependsOn: ["app"], ddl: `CREATE FUNCTION ${S}.audit() RETURNS event_trigger LANGUAGE plpgsql AS $$ BEGIN END $$` },
  { export: "ddlAudit", type: "Postgres::EventTrigger", dependsOn: ["audit"], ddl: `CREATE EVENT TRIGGER ddl_audit_3911 ON ddl_command_end WHEN TAG IN (${v.tags}) EXECUTE FUNCTION ${S}.audit();\nCOMMENT ON EVENT TRIGGER ddl_audit_3911 IS 'Audits DDL'` },
];

const V1: Version = { pair: "a integer, b text COLLATE \"C\"", initcond: "0", diff: ", SUBTYPE_DIFF = float8mi", locale: "und-u-ks-level2", context: " AS ASSIGNMENT", tags: "'CREATE TABLE'" };
// Each kind changed: the aggregate's INITCOND (OR REPLACE), the range's SUBTYPE_DIFF (a column uses the type: refused), the cast's context and the event trigger's tags (drop and create).
const V2: Version = { ...V1, initcond: "'10'", diff: "", context: " AS IMPLICIT", tags: "'CREATE TABLE', 'ALTER TABLE'" };

describe.skipIf(!enabled)("types, aggregates, collations, casts and event triggers on a live server", () => {
  test("apply, plan, drift, change and import", async () => {
    const v1 = writeBuild("v1.json", objects(V1));
    const first = await apply(v1);
    expect(first.failed).toEqual([]);
    expect(first.applied.map((a) => [a.name, a.action])).toEqual([
      [S, "created"],
      [`${S}.ci`, "created"],
      [`${S}.pair`, "created"],
      [`${S}.floatrange`, "created"],
      [`${S}.people`, "created"],
      [`${S}.add2(integer,integer)`, "created"],
      [`${S}.total(integer)`, "created"],
      [`${S}.pair_text(${S}.pair)`, "created"],
      [`(${S}.pair AS text)`, "created"],
      [`${S}.audit()`, "created"],
      ["ddl_audit_3911", "created"],
    ]);
    // Each works: the aggregate sums, the cast casts, the collation compares without case, the range has its multirange.
    expect((await admin.query<{ t: number }>(`SELECT ${S}.total(x) AS t FROM generate_series(1, 4) x`))[0]!.t).toBe(10);
    expect((await admin.query<{ t: string }>(`SELECT ROW(1, 'x')::${S}.pair::text AS t`))[0]!.t).toBe("1:x");
    expect((await admin.query<{ eq: boolean }>(`SELECT 'Ab' = 'aB' COLLATE ${S}.ci AS eq`))[0]!.eq).toBe(true);
    expect((await admin.query<{ m: string }>(`SELECT '{[1,2)}'::${S}.floatmultirange::text AS m`))[0]!.m).toBe("{[1,2)}");

    // As declared: no change, and no drift.
    expect((await plan(v1)).changes).toEqual([]);
    const declared = declaredObjects(JSON.stringify({ dialect: "postgres", objects: objects(V1).map((o) => ({ dependsOn: [], ...o })) }));
    const entities = new Map(declared.map((o) => [o.exportName, { entityType: o.type, props: o.props }]));
    const deep = await observeResourcesDeep({ environment: "e2e", entityNames: [...entities.keys()], entities, ...profile() });
    expect(deep.unobserved ?? {}).toEqual({});
    const strip = (p: Record<string, unknown>) => Object.fromEntries(Object.entries(p).filter(([k]) => !["ddl", "source", "reads", "orReplace"].includes(k)));
    for (const [name, e] of entities) expect(strip(deep.resources[name]!.properties), name).toEqual(strip(e.props));

    // Changed by hand: drift, in the plan.
    await admin.query(`CREATE OR REPLACE AGGREGATE ${S}.total(integer) (SFUNC = ${S}.add2, STYPE = int4, INITCOND = '5', PARALLEL = SAFE)`);
    expect((await plan(v1)).changes.map((c) => [c.object, c.field, c.rule])).toEqual([[`total (${S}.total(integer))`, "definition", "SQLPG302"]]);

    // Changed in the declaration: each with its rule; the range is used by a column, so its change is refused.
    const v2 = writeBuild("v2.json", objects(V2));
    const planned = await plan(v2);
    expect(planned.changes.map((c) => [c.object, c.rule])).toEqual([
      [`floatrange (${S}.floatrange)`, "SQLPG301"],
      [`total (${S}.total(integer))`, "SQLPG302"],
      [`pairCast ((${S}.pair AS text))`, "SQLPG300"],
      ["ddlAudit (ddl_audit_3911)", "SQLPG300"],
    ]);
    expect(planned.refused.map((c) => c.object)).toEqual([`floatrange (${S}.floatrange)`]);
    const v2Applied = writeBuild("v2-applied.json", objects({ ...V2, diff: V1.diff }));
    const second = await apply(v2Applied);
    expect(second.failed).toEqual([]);
    expect(second.applied.filter((a) => a.action === "updated").map((a) => a.name)).toEqual([`${S}.total(integer)`, `(${S}.pair AS text)`, "ddl_audit_3911"]);
    expect((await plan(v2Applied)).changes).toEqual([]);
    expect((await admin.query<{ t: number }>(`SELECT ${S}.total(x) AS t FROM generate_series(1, 4) x`))[0]!.t).toBe(20);

    // Import: the server's own printing, written back as declarations that parse and plan with no change.
    const live = await readLiveSchema(admin, { schemas: [S] });
    for (const o of live) liveProps(o);
    const ir = objectsToIR(live.map((o) => ({ type: o.type, ...(o.schema ? { schema: o.schema } : {}), name: o.name, ddl: o.statement })));
    const [file] = new PostgresGenerator().generate(ir);
    expect(file!.content).toContain("export const ci = collation`");
    expect(file!.content).toContain("export const pair = type`");
    expect(file!.content).toContain("export const floatrange = type`");
    expect(file!.content).toContain("export const total = aggregate`");
    expect(file!.content).toContain("SFUNC = ${add2}");
    expect(file!.content).toContain("cast`\n  CREATE CAST (${pair} AS text) WITH FUNCTION ${pairText}(${pair}) AS IMPLICIT");
    expect(file!.content).toContain("export const ddlAudit3911 = eventTrigger`");
    // The imported statements, in the generator's order, as a build: no change against the server they came from.
    const items = ir.resources.map((r) => ({ exportName: r.logicalId, type: r.type, ...(r.properties.schema ? { schema: String(r.properties.schema) } : {}), name: String(r.properties.name), ddl: String(r.properties.ddl) }));
    const { order } = postgresTemplates(items);
    const imported = writeBuild("imported.json", order.map((it) => ({ export: it.exportName, type: it.type, ddl: it.ddl })));
    expect((await plan(imported)).changes).toEqual([]);
  }, 600_000);
});
