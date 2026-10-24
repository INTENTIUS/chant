/**
 * Extended statistics, foreign data wrappers, foreign servers and
 * publications against a live server (#3911): applied as declared, they plan
 * with no change and read back with no drift; a definition changed in the
 * declaration is altered in place (SQLPG303) or dropped and created
 * (SQLPG300); an import writes each back as the declaration it came from,
 * which plans with no change.
 *
 * The server: a throwaway one at the pin, skipped cleanly when Docker is not
 * available. A foreign data wrapper takes a superuser, which the throwaway
 * server's user is.
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

const SCHEMA = "chant_e2e_3911b";
const enabled = await dockerAvailable();
const dir = mkdtempSync(join(tmpdir(), "chant-pg-database-kinds-"));
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

const MARKER = { stack: "e2e3911b", env: "test" };
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
interface Version {
  /** The statistics' kinds. */
  kinds: string;
  /** The wrapper's options. */
  fdwOptions: string;
  /** The server's version and options. */
  server: string;
  /** The publication's tables and options. */
  publication: string;
}

const objects = (v: Version): Obj[] => [
  { export: "app", type: "Postgres::Schema", ddl: `CREATE SCHEMA ${S}` },
  { export: "orders", type: "Postgres::Table", dependsOn: ["app"], ddl: `CREATE TABLE ${S}.orders (id int PRIMARY KEY, user_id int, status text)` },
  { export: "events", type: "Postgres::Table", dependsOn: ["app"], ddl: `CREATE TABLE ${S}.events (id int PRIMARY KEY)` },
  { export: "ordersStats", type: "Postgres::Statistics", dependsOn: ["orders"], ddl: `CREATE STATISTICS ${S}.orders_stats ${v.kinds} ON user_id, status FROM ${S}.orders;\nCOMMENT ON STATISTICS ${S}.orders_stats IS 'Correlated'` },
  { export: "appFdw", type: "Postgres::ForeignDataWrapper", ddl: `CREATE FOREIGN DATA WRAPPER app_fdw_3911 ${v.fdwOptions};\nCOMMENT ON FOREIGN DATA WRAPPER app_fdw_3911 IS 'Remote'` },
  { export: "replica", type: "Postgres::ForeignServer", dependsOn: ["appFdw"], ddl: `CREATE SERVER replica_3911 ${v.server} FOREIGN DATA WRAPPER app_fdw_3911 OPTIONS (host 'db.internal');\nCOMMENT ON SERVER replica_3911 IS 'The replica'` },
  { export: "pub", type: "Postgres::Publication", dependsOn: ["orders", "events"], ddl: `CREATE PUBLICATION pub_3911 ${v.publication};\nCOMMENT ON PUBLICATION pub_3911 IS 'Order changes'` },
];

const V1: Version = {
  kinds: "(dependencies)",
  fdwOptions: "OPTIONS (debug 'true')",
  server: "TYPE 'pg' VERSION '16'",
  publication: `FOR TABLE ${S}.orders WITH (publish = 'insert, update')`,
};
// Each kind changed: the statistics' kinds (drop and create), the wrapper's options, the server's version and the publication's tables and options (in place).
const V2: Version = {
  kinds: "(ndistinct)",
  fdwOptions: "OPTIONS (debug 'false', trace 'on')",
  server: "TYPE 'pg' VERSION '17'",
  publication: `FOR TABLE ${S}.events WITH (publish = 'insert')`,
};

describe.skipIf(!enabled)("statistics, foreign servers and publications on a live server", () => {
  test("apply, plan, drift, change and import", async () => {
    const v1 = writeBuild("v1.json", objects(V1));
    const first = await apply(v1);
    expect(first.failed).toEqual([]);
    expect(first.applied.map((a) => [a.name, a.action])).toEqual([
      [S, "created"],
      [`${S}.orders`, "created"],
      [`${S}.events`, "created"],
      [`${S}.orders_stats`, "created"],
      ["app_fdw_3911", "created"],
      ["replica_3911", "created"],
      ["pub_3911", "created"],
    ]);

    // As declared: no change, and no drift.
    expect((await plan(v1)).changes).toEqual([]);
    const declared = declaredObjects(JSON.stringify({ dialect: "postgres", objects: objects(V1).map((o) => ({ dependsOn: [], ...o })) }));
    const entities = new Map(declared.map((o) => [o.exportName, { entityType: o.type, props: o.props }]));
    const deep = await observeResourcesDeep({ environment: "e2e", entityNames: [...entities.keys()], entities, ...profile() });
    expect(deep.unobserved ?? {}).toEqual({});

    // Changed by hand: drift, in the plan.
    await admin.query(`ALTER SERVER replica_3911 OPTIONS (SET host 'elsewhere')`);
    expect((await plan(v1)).changes.map((c) => [c.object, c.field, c.rule])).toEqual([["replica (replica_3911)", "options", "SQLPG303"]]);
    await admin.query(`ALTER SERVER replica_3911 OPTIONS (SET host 'db.internal')`);

    // Changed in the declaration: the statistics are dropped and created; the rest altered in place.
    const v2 = writeBuild("v2.json", objects(V2));
    const planned = await plan(v2);
    expect(planned.changes.map((c) => [c.object, c.rule])).toEqual([
      [`ordersStats (${S}.orders_stats)`, "SQLPG300"],
      ["appFdw (app_fdw_3911)", "SQLPG303"],
      ["replica (replica_3911)", "SQLPG303"],
      ["pub (pub_3911)", "SQLPG303"],
      ["pub (pub_3911)", "SQLPG303"],
      ["pub (pub_3911)", "SQLPG303"],
    ]);
    expect(planned.refused).toEqual([]);
    const second = await apply(v2);
    expect(second.failed).toEqual([]);
    expect((await plan(v2)).changes).toEqual([]);
    expect((await admin.query<{ n: number }>(`SELECT count(*)::int AS n FROM pg_publication_rel r JOIN pg_publication p ON p.oid = r.prpubid WHERE p.pubname = 'pub_3911'`))[0]!.n).toBe(1);

    // Import: the server's own printing, written back as declarations that parse and plan with no change.
    const live = await readLiveSchema(admin, { schemas: [S] });
    for (const o of live) liveProps(o);
    const ir = objectsToIR(live.map((o) => ({ type: o.type, ...(o.schema ? { schema: o.schema } : {}), name: o.name, ddl: o.statement })));
    const [file] = new PostgresGenerator().generate(ir);
    expect(file!.content).toContain("export const ordersStats = statistics`");
    expect(file!.content).toContain("export const appFdw3911 = foreignDataWrapper`");
    expect(file!.content).toContain("FOREIGN DATA WRAPPER ${appFdw3911}");
    expect(file!.content).toContain("export const pub3911 = publication`");
    const items = ir.resources.map((r) => ({ exportName: r.logicalId, type: r.type, ...(r.properties.schema ? { schema: String(r.properties.schema) } : {}), name: String(r.properties.name), ddl: String(r.properties.ddl) }));
    const { order } = postgresTemplates(items);
    const imported = writeBuild("imported.json", order.map((it) => ({ export: it.exportName, type: it.type, ddl: it.ddl })));
    expect((await plan(imported)).changes).toEqual([]);
  }, 600_000);
});
