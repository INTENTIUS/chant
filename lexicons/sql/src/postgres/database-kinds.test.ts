/**
 * Extended statistics, foreign data wrappers, foreign servers and
 * publications (#3911): what the tags parse and refuse, how a change to each
 * is classified and made, how the catalog reader prints each, and the round
 * trip: declare, build, import, plan with no change.
 */

import { describe, expect, test } from "vitest";
import { foreignDataWrapper, foreignServer, func, publication, schema, SqlTemplateError, statistics, table } from "./entities";
import { diffObject, keyedByQualifiedName, pgSchemaFromLive, type PgSchemaObject } from "./plan/schema";
import { diffPgSchemas, matchPgObjects } from "./plan/diff";
import { alterSteps, dropStatement } from "./apply/statements";
import { declaredObjects } from "./apply/apply";
import { readLiveSchema, type LivePgObject } from "./live/catalog";
import { readDatabaseKinds } from "./live/catalog-kinds";
import type { PostgresClient } from "./live/client";
import { objectsToIR } from "./import/ir";
import { PostgresGenerator, postgresTemplates } from "./import/generator";
import { canonicalPgObject } from "./plan/normalize";
import { liveProps } from "./plan/deep";
import { fakeClient } from "./testing/fake-client";
import { kindRow } from "../coverage";

const app = schema`CREATE SCHEMA app`;
const props = (o: { props: unknown }) => o.props as Record<string, unknown>;

describe("the tags", () => {
  test("statistics: a table's columns and expressions, the kinds the server gathers", () => {
    const orders = table`CREATE TABLE ${app}.orders (id int, status text, total numeric)`;
    const s = statistics`CREATE STATISTICS ${app}.orders_stats (dependencies, ndistinct) ON status, id, (total * 2) FROM ${orders}; COMMENT ON STATISTICS ${app}.orders_stats IS 'Correlated'`;
    expect(s.entityType).toBe("Postgres::Statistics");
    expect(s.dependsOn).toContain(orders);
    expect(s.props).toMatchObject({ schema: "app", name: "orders_stats", kinds: ["dependencies", "ndistinct"], tableName: "app.orders", comment: "Correlated" });
    // Sorted, and the kinds the server builds when none are written are no list at all.
    const c = canonicalPgObject(s.entityType, props(s));
    expect(c.fields).toMatchObject({ table: "app.orders", kinds: ["dependencies", "ndistinct"], targets: ["id", "status", "total * 2"] });
    const all = statistics`CREATE STATISTICS app.s ON a, b FROM app.t`;
    const listed = statistics`CREATE STATISTICS app.s (mcv, ndistinct, dependencies) ON b, a FROM app.t`;
    expect(canonicalPgObject(all.entityType, props(all)).fields).toEqual(canonicalPgObject(listed.entityType, props(listed)).fields);
    const lone = statistics`CREATE STATISTICS app.e ON (lower(email)) FROM app.t`;
    expect(canonicalPgObject(lone.entityType, props(lone)).fields.kinds).toEqual(["none"]);
  });

  test("a foreign data wrapper and a foreign server, the database's and without a schema", () => {
    const handler = func`CREATE FUNCTION ${app}.fdw_handler() RETURNS fdw_handler LANGUAGE c AS 'x', 'y'`;
    const fdw = foreignDataWrapper`CREATE FOREIGN DATA WRAPPER app_fdw HANDLER ${handler} NO VALIDATOR OPTIONS (debug 'true'); COMMENT ON FOREIGN DATA WRAPPER app_fdw IS 'Remote'`;
    expect(fdw.entityType).toBe("Postgres::ForeignDataWrapper");
    expect(fdw.sqlName).toBe("app_fdw");
    expect(fdw.dependsOn).toContain(handler);
    expect(fdw.props).toMatchObject({ name: "app_fdw", handlerName: "app.fdw_handler", noValidator: true, options: { debug: "true" }, comment: "Remote" });
    expect(canonicalPgObject(fdw.entityType, props(fdw))).toMatchObject({ schema: undefined, fields: { handler: "app.fdw_handler", options: { debug: "true" } } });
    expect(canonicalPgObject(fdw.entityType, props(fdw)).fields).not.toHaveProperty("validator");

    const server = foreignServer`CREATE SERVER IF NOT EXISTS app_remote TYPE 'pg' VERSION '16' FOREIGN DATA WRAPPER ${fdw} OPTIONS (host 'db.internal', port '5432'); COMMENT ON SERVER app_remote IS 'The replica'`;
    expect(server.dependsOn).toContain(fdw);
    expect(server.props).toMatchObject({ name: "app_remote", serverType: "pg", version: "16", wrapperName: "app_fdw", options: { host: "db.internal", port: "5432" }, comment: "The replica" });
    expect(canonicalPgObject(server.entityType, props(server)).fields).toMatchObject({ serverType: "pg", version: "16", wrapper: "app_fdw", options: { host: "db.internal", port: "5432" } });
  });

  test("a publication: all tables, or tables with column lists and filters, or schemas, and its options", () => {
    const orders = table`CREATE TABLE ${app}.orders (id int, status text)`;
    const audit = schema`CREATE SCHEMA audit`;
    const p = publication`CREATE PUBLICATION app_pub FOR TABLE ONLY ${orders} (status, id) WHERE (id > 0), app.users, TABLES IN SCHEMA ${audit} WITH (publish = 'update, insert', publish_via_partition_root = on)`;
    expect(p.entityType).toBe("Postgres::Publication");
    expect(p.dependsOn).toEqual(expect.arrayContaining([orders, audit]));
    expect(canonicalPgObject(p.entityType, props(p)).fields).toMatchObject({
      tables: [{ table: "app.orders", columns: ["id", "status"], where: "id > 0" }, { table: "app.users" }],
      schemas: ["audit"],
      publish: ["insert", "update"],
      viaRoot: true,
    });
    const all = publication`CREATE PUBLICATION everything FOR ALL TABLES WITH (publish = 'insert, update, delete, truncate')`;
    expect(canonicalPgObject(all.entityType, props(all)).fields).toEqual({ allTables: true });
    expect(canonicalPgObject(all.entityType, props(all)).fields.publish).toBeUndefined();
    const empty = publication`CREATE PUBLICATION nothing`;
    expect(canonicalPgObject(empty.entityType, props(empty)).fields).not.toHaveProperty("tables");
  });

  test("what is refused", () => {
    expect(() => foreignServer`CREATE SERVER s FOREIGN DATA WRAPPER w OPTIONS (host 'x', password 'hunter2')`).toThrow(/holds a credential/);
    expect(() => foreignDataWrapper`CREATE FOREIGN DATA WRAPPER w OPTIONS (api_key 'x')`).toThrow(SqlTemplateError);
    expect(() => foreignServer`CREATE SERVER s OPTIONS (host 'x')`).toThrow(/FOREIGN DATA WRAPPER/);
    expect(() => foreignServer`CREATE SERVER app.s FOREIGN DATA WRAPPER w`).toThrow(/without a schema/);
    expect(() => foreignServer`CREATE SERVER s FOREIGN DATA WRAPPER w OPTIONS (host 'a', host 'b')`).toThrow(/given twice/);
    expect(() => publication`CREATE PUBLICATION p WITH (publich = 'insert')`).toThrow(/an option of a publication/);
    expect(() => publication`CREATE PUBLICATION p FOR`).toThrow();
    expect(() => statistics`CREATE STATISTICS app.s (histogram) ON a, b FROM app.t`).toThrow(/statistics kind/);
    expect(() => statistics`CREATE STATISTICS app.s ON a, b`).toThrow(/FROM/);
    expect(() => statistics`CREATE USER MAPPING FOR u SERVER s`).toThrow(SqlTemplateError);
    expect(() => publication`CREATE STATISTICS app.s ON a, b FROM app.t`).toThrow(/use the statistics tag/);
  });
});

// ── Classifying and making changes ─────────────────────────────────────

const live = (type: string, statement: string, extra: Partial<LivePgObject> = {}) => pgSchemaFromLive([{ type, statement, name: "", oid: "1", ...extra } as LivePgObject], "public");
const declared = (type: string, ddl: string): PgSchemaObject[] => keyedByQualifiedName([{ key: "x", canonical: { ...diffObject(type, ddl, "public"), exportName: "x" } }]);
const rules = (type: string, before: string, after: string, extra: Partial<LivePgObject> = {}) =>
  diffPgSchemas(live(type, before, extra), declared(type, after)).changes.map((c) => [c.field, c.rule]);

function steps(type: string, liveDdl: string, declaredDdl: string, extra: Partial<LivePgObject> = {}): string[] {
  const [obj] = declaredObjects(JSON.stringify({ dialect: "postgres", objects: [{ export: "x", type, ddl: declaredDdl, dependsOn: [] }] }));
  const after = keyedByQualifiedName([{ key: "x", canonical: obj!.canonical }]);
  const before = live(type, liveDdl, extra);
  const m = matchPgObjects(before, after).find((x) => x.kind === "matched")!;
  return alterSteps(obj!, m.before!.canonical, diffPgSchemas(before, after).changes, { major: 18 }).steps.map((s) => s.sql);
}

const STAT = "Postgres::Statistics";
const FDW = "Postgres::ForeignDataWrapper";
const SRV = "Postgres::ForeignServer";
const PUB = "Postgres::Publication";

describe("the classifier and the statements", () => {
  test("the server's printing is the declaration's", () => {
    expect(rules(STAT, "CREATE STATISTICS app.s ON a, b FROM app.t", "CREATE STATISTICS app.s (ndistinct, dependencies, mcv) ON b, a FROM app.t")).toEqual([]);
    expect(rules(STAT, "CREATE STATISTICS app.s (dependencies) ON a, (b + 1) FROM app.t", "CREATE STATISTICS app.s (dependencies) ON (b + 1), a FROM app.t")).toEqual([]);
    expect(rules(FDW, "CREATE FOREIGN DATA WRAPPER w HANDLER app.h OPTIONS (a '1', b '2')", "CREATE FOREIGN DATA WRAPPER w HANDLER app.h NO VALIDATOR OPTIONS (b '2', a '1')")).toEqual([]);
    expect(rules(SRV, "CREATE SERVER s TYPE 'pg' FOREIGN DATA WRAPPER w OPTIONS (host 'h')", "CREATE SERVER s TYPE 'pg' FOREIGN DATA WRAPPER w OPTIONS (host 'h')")).toEqual([]);
    expect(
      rules(PUB, "CREATE PUBLICATION p FOR TABLE app.a (id), app.b, TABLES IN SCHEMA s WITH (publish = 'insert, update')", "CREATE PUBLICATION p FOR TABLE app.b, app.a (id), TABLES IN SCHEMA s WITH (publish = 'update,insert')"),
    ).toEqual([]);
    // Options at their default are no change: the publication publishes every action, to its own tables, unless told otherwise.
    expect(rules(PUB, "CREATE PUBLICATION p FOR ALL TABLES", "CREATE PUBLICATION p FOR ALL TABLES WITH (publish = 'insert, update, delete, truncate', publish_via_partition_root = false)")).toEqual([]);
  });

  test("statistics are dropped and created: they have no ALTER for their definition", () => {
    const S1 = "CREATE STATISTICS app.s ON a, b FROM app.t";
    const S2 = "CREATE STATISTICS app.s (dependencies) ON a, b FROM app.t";
    expect(rules(STAT, S1, S2)).toEqual([["kinds", "SQLPG300"]]);
    expect(rules(STAT, S1, "CREATE STATISTICS app.s ON a, c FROM app.t")).toEqual([["targets", "SQLPG300"]]);
    expect(rules(STAT, S1, "CREATE STATISTICS app.s ON a, b FROM app.u")).toEqual([["table", "SQLPG300"]]);
    const recreate = steps(STAT, S1, S2);
    expect(recreate[0]).toBe("DROP STATISTICS app.s");
    expect(recreate[1]).toBe(S2);
    expect(recreate[2]).toMatch(/^COMMENT ON STATISTICS app\.s IS /);
    expect(dropStatement("statistics", "app", "s").sql).toBe("DROP STATISTICS app.s");
  });

  test("a wrapper is altered in place", () => {
    const W1 = "CREATE FOREIGN DATA WRAPPER w HANDLER app.h OPTIONS (a '1', b '2')";
    const W2 = "CREATE FOREIGN DATA WRAPPER w NO HANDLER VALIDATOR app.v OPTIONS (a '9', c '3')";
    expect(rules(FDW, W1, W2)).toEqual([
      ["handler", "SQLPG303"],
      ["validator", "SQLPG303"],
      ["options", "SQLPG303"],
    ]);
    expect(steps(FDW, W1, W2)).toEqual(["ALTER FOREIGN DATA WRAPPER w NO HANDLER VALIDATOR app.v OPTIONS (ADD c '3', SET a '9', DROP b)"]);
    expect(dropStatement("foreignDataWrapper", undefined, "w").sql).toBe("DROP FOREIGN DATA WRAPPER w");
  });

  test("a server's version and options are altered in place; its type and wrapper are not", () => {
    const V1 = "CREATE SERVER s TYPE 'pg' VERSION '15' FOREIGN DATA WRAPPER w OPTIONS (host 'a')";
    expect(rules(SRV, V1, V1.replace("'15'", "'16'").replace("'a'", "'b'"))).toEqual([
      ["version", "SQLPG303"],
      ["options", "SQLPG303"],
    ]);
    expect(steps(SRV, V1, V1.replace("VERSION '15' ", "").replace("'a'", "'b'"))).toEqual(["ALTER SERVER s VERSION NULL OPTIONS (SET host 'b')"]);
    expect(rules(SRV, V1, V1.replace("w OPTIONS", "w2 OPTIONS"))).toEqual([["wrapper", "SQLPG300"]]);
    expect(rules(SRV, V1, V1.replace("w OPTIONS", "w2 OPTIONS"), { dependents: ["foreign table app.remote_orders"] })).toEqual([["wrapper", "SQLPG301"]]);
    const recreate = steps(SRV, V1, V1.replace("'pg'", "'mysql'"));
    expect(recreate[0]).toBe("DROP SERVER s");
    expect(recreate[1]).toMatch(/^CREATE SERVER s TYPE 'mysql'/);
  });

  test("a publication is altered in place: options, tables and schemas", () => {
    const P1 = "CREATE PUBLICATION p FOR TABLE app.a (id), app.b, TABLES IN SCHEMA s1";
    const P2 = "CREATE PUBLICATION p FOR TABLE app.a (id, name) WHERE (id > 0), app.c, TABLES IN SCHEMA s2 WITH (publish = 'insert', publish_via_partition_root = true)";
    expect(rules(PUB, P1, P2).map(([f]) => f)).toEqual(["tables", "schemas", "publish", "viaRoot"]);
    expect(steps(PUB, P1, P2)).toEqual([
      "ALTER PUBLICATION p SET (publish = 'insert', publish_via_partition_root = true)",
      "ALTER PUBLICATION p DROP TABLE app.a",
      "ALTER PUBLICATION p DROP TABLE app.b",
      "ALTER PUBLICATION p ADD TABLE app.a (id, name) WHERE (id > 0)",
      "ALTER PUBLICATION p ADD TABLE app.c",
      "ALTER PUBLICATION p DROP TABLES IN SCHEMA s1",
      "ALTER PUBLICATION p ADD TABLES IN SCHEMA s2",
    ]);
    // Back to the defaults is written out: the server has no RESET for a publication's options.
    expect(steps(PUB, "CREATE PUBLICATION p WITH (publish = 'insert', publish_via_partition_root = true)", "CREATE PUBLICATION p")).toEqual([
      "ALTER PUBLICATION p SET (publish = 'insert, update, delete, truncate', publish_via_partition_root = false)",
    ]);
    // FOR ALL TABLES cannot be altered into or out of.
    expect(rules(PUB, "CREATE PUBLICATION p FOR ALL TABLES", "CREATE PUBLICATION p FOR TABLE app.a")).toEqual([["allTables", "SQLPG300"]]);
    expect(steps(PUB, "CREATE PUBLICATION p FOR ALL TABLES", "CREATE PUBLICATION p FOR TABLE app.a")[0]).toBe("DROP PUBLICATION p");
  });

  test("a comment changes in place", () => {
    expect(steps(SRV, "CREATE SERVER s FOREIGN DATA WRAPPER w", "CREATE SERVER s FOREIGN DATA WRAPPER w; COMMENT ON SERVER s IS 'x'")).toEqual([expect.stringMatching(/^COMMENT ON SERVER s IS 'x/)]);
    expect(steps(PUB, "CREATE PUBLICATION p", "CREATE PUBLICATION p; COMMENT ON PUBLICATION p IS 'x'")).toEqual([expect.stringMatching(/^COMMENT ON PUBLICATION p IS 'x/)]);
  });
});

// ── Reading the catalog ────────────────────────────────────────────────

/** Answers the database-kind reader's queries from rows, by the catalog each reads. */
function catalogClient(rows: { stats?: unknown[]; wrappers?: unknown[]; servers?: unknown[]; pubs?: unknown[]; pubTables?: unknown[]; pubSchemas?: unknown[]; version15?: boolean }): PostgresClient {
  return {
    async query<T>(sql: string): Promise<T[]> {
      const r = (x: unknown[] | undefined) => (x ?? []) as T[];
      if (sql.includes("pg_get_statisticsobjdef")) return r(rows.stats);
      if (sql.includes("FROM pg_catalog.pg_foreign_data_wrapper w")) return r(rows.wrappers);
      if (sql.includes("FROM pg_catalog.pg_foreign_server v")) return r(rows.servers);
      if (sql.includes("FROM pg_catalog.pg_publication p")) return r(rows.pubs);
      if (sql.includes("FROM pg_catalog.pg_publication_rel r")) return r(rows.pubTables);
      if (sql.includes("FROM pg_catalog.pg_publication_namespace pn")) return r(rows.pubSchemas);
      // The 15 features: the column list, and schema members.
      if (sql.includes("attname = 'prattrs'") || sql.includes("to_regclass('pg_catalog.pg_publication_namespace')")) return rows.version15 ? r([{ x: 1 }]) : [];
      return [];
    },
    async end() {},
  };
}

describe("reading the catalog", () => {
  test("each kind is assembled from its rows, a credential left out and said so", async () => {
    const objects = await readDatabaseKinds(
      catalogClient({
        version15: true,
        stats: [{ oid: "1", schema: "app", name: "s", def: "CREATE STATISTICS app.s (dependencies) ON a, b FROM app.t", comment: "Linked" }],
        wrappers: [{ oid: "2", name: "app_fdw", handler: "app.h", validator: null, options: ["debug=true"], comment: null, dependents: ["server app_remote"] }],
        servers: [{ oid: "3", name: "app_remote", type: "pg", version: null, wrapper: "app_fdw", options: ["host=db", "sslpassword=x", "password=y"], comment: "It's remote", dependents: [] }],
        pubs: [{ oid: "4", name: "app_pub", alltables: false, pubinsert: true, pubupdate: true, pubdelete: false, pubtruncate: false, def: { pubviaroot: true, pubgencols: "n" }, comment: null }],
        pubTables: [{ schema: "app", name: "t", columns: ['"a"', '"b"'], filter: "a > 0" }, { schema: "app", name: "u", columns: [], filter: null }],
        pubSchemas: [{ name: "audit" }],
      }),
      {},
    );
    expect(objects.map((o) => [o.type, o.name])).toEqual([
      [STAT, "s"],
      [FDW, "app_fdw"],
      [SRV, "app_remote"],
      [PUB, "app_pub"],
    ]);
    expect(objects[0]!.statement).toBe("CREATE STATISTICS app.s (dependencies) ON a, b FROM app.t;\nCOMMENT ON STATISTICS app.s IS 'Linked'");
    expect(objects[1]).toMatchObject({ statement: "CREATE FOREIGN DATA WRAPPER app_fdw HANDLER app.h OPTIONS (debug 'true')", dependents: ["server app_remote"] });
    expect(objects[2]!.statement).toBe("CREATE SERVER app_remote TYPE 'pg' FOREIGN DATA WRAPPER app_fdw OPTIONS (host 'db');\nCOMMENT ON SERVER app_remote IS 'It''s remote'");
    expect(objects[2]!.warnings).toEqual(["the options sslpassword, password hold a credential and are left out; the environment supplies it"]);
    expect(objects[3]!.statement).toBe(
      "CREATE PUBLICATION app_pub FOR TABLE app.t (\"a\", \"b\") WHERE (a > 0), app.u, TABLES IN SCHEMA audit WITH (publish = 'insert, update', publish_via_partition_root = true)",
    );
    // Each parses back with its own tag.
    for (const o of objects) expect(() => liveProps(o)).not.toThrow();
  });

  test("a publication of every table, on a server before 15", async () => {
    const [p] = await readDatabaseKinds(catalogClient({ pubs: [{ oid: "4", name: "all_of_it", alltables: true, pubinsert: true, pubupdate: true, pubdelete: true, pubtruncate: true, def: { pubviaroot: false }, comment: null }] }), {});
    expect(p!.statement).toBe("CREATE PUBLICATION all_of_it FOR ALL TABLES");
  });

  test("the schema reader includes them, after the functions they call", async () => {
    const log: string[] = [];
    await readLiveSchema(fakeClient({}, log), { schemas: ["app"] });
    expect(log.some((q) => q.includes("pg_get_statisticsobjdef"))).toBe(true);
    expect(log.some((q) => q.includes("pg_foreign_server"))).toBe(true);
    expect(log.some((q) => q.includes("FROM pg_catalog.pg_publication p"))).toBe(true);
  });
});

// ── The round trip ─────────────────────────────────────────────────────

/** What the server prints for the objects below. */
const SERVER_PRINTS: Array<{ type: string; schema?: string; name: string; statement: string }> = [
  { type: "Postgres::Schema", name: "app", statement: "CREATE SCHEMA app" },
  { type: "Postgres::Schema", name: "audit", statement: "CREATE SCHEMA audit" },
  { type: "Postgres::Table", schema: "app", name: "orders", statement: "CREATE TABLE app.orders (\n    id integer,\n    status text\n)" },
  { type: STAT, schema: "app", name: "orders_stats", statement: "CREATE STATISTICS app.orders_stats (dependencies) ON id, status FROM app.orders;\nCOMMENT ON STATISTICS app.orders_stats IS 'Correlated'" },
  { type: FDW, name: "app_fdw", statement: "CREATE FOREIGN DATA WRAPPER app_fdw OPTIONS (debug 'true');\nCOMMENT ON FOREIGN DATA WRAPPER app_fdw IS 'Remote'" },
  { type: SRV, name: "app_remote", statement: "CREATE SERVER app_remote TYPE 'pg' VERSION '16' FOREIGN DATA WRAPPER app_fdw OPTIONS (host 'db.internal', port '5432')" },
  { type: PUB, name: "app_pub", statement: "CREATE PUBLICATION app_pub FOR TABLE app.orders (id, status) WHERE (id > 0), TABLES IN SCHEMA audit WITH (publish = 'insert, update')" },
];

describe("declare, build, import, plan with no change", () => {
  const liveObjects = (): LivePgObject[] => SERVER_PRINTS.map((o, i) => ({ oid: String(i), ...o }) as LivePgObject);

  test("a declaration the server prints back plans with no change", () => {
    const orders = table`CREATE TABLE ${app}.orders (id int, status text)`;
    const audit = schema`CREATE SCHEMA audit`;
    const fdw = foreignDataWrapper`CREATE FOREIGN DATA WRAPPER app_fdw OPTIONS (debug 'true'); COMMENT ON FOREIGN DATA WRAPPER app_fdw IS 'Remote'`;
    const objects = [
      app,
      audit,
      orders,
      statistics`CREATE STATISTICS ${app}.orders_stats (dependencies) ON status, id FROM ${orders}; COMMENT ON STATISTICS ${app}.orders_stats IS 'Correlated'`,
      fdw,
      foreignServer`CREATE SERVER app_remote TYPE 'pg' VERSION '16' FOREIGN DATA WRAPPER ${fdw} OPTIONS (port '5432', host 'db.internal')`,
      publication`CREATE PUBLICATION app_pub FOR TABLE ${orders} (status, id) WHERE (id > 0), TABLES IN SCHEMA ${audit} WITH (publish = 'update, insert')`,
    ];
    // The build: each entity's DDL, rendered, as the build output holds it.
    const build = JSON.stringify({ dialect: "postgres", objects: objects.map((o, i) => ({ export: `o${i}`, type: o.entityType, ddl: (o.props as { ddl: string }).ddl, dependsOn: [] })) });
    const declaredSchema = keyedByQualifiedName(declaredObjects(build).map((d) => ({ key: d.exportName, canonical: d.canonical })));
    expect(diffPgSchemas(pgSchemaFromLive(liveObjects(), "public"), declaredSchema).changes).toEqual([]);
  });

  test("import writes each as a declaration, which builds to the same objects", () => {
    const ir = objectsToIR(SERVER_PRINTS.map((o) => ({ type: o.type, ...(o.schema ? { schema: o.schema } : {}), name: o.name, ddl: o.statement })));
    const [file] = new PostgresGenerator().generate(ir);
    const content = file!.content;
    expect(content).toContain('import { foreignDataWrapper, foreignServer, publication, schema, statistics, table } from "@intentius/chant-lexicon-sql/postgres";');
    expect(content).toContain("export const ordersStats = statistics`");
    expect(content).toContain("CREATE STATISTICS ${appSchema}.orders_stats (dependencies) ON id, status FROM ${orders}");
    expect(content).toContain("export const appFdw = foreignDataWrapper`");
    expect(content).toContain("FOREIGN DATA WRAPPER ${appFdw} OPTIONS (host 'db.internal'");
    expect(content).toContain("export const appPub = publication`");
    expect(content).toContain("TABLES IN SCHEMA ${auditSchema} WITH (publish = 'insert, update')");
    expect(content).toContain("FOR TABLE ${orders} (id, status) WHERE (id > 0)");

    // The imported statements, in the generator's order, as a build: no change against the objects they came from.
    const items = ir.resources.map((r) => ({ exportName: r.logicalId, type: r.type, ...(r.properties.schema ? { schema: String(r.properties.schema) } : {}), name: String(r.properties.name), ddl: String(r.properties.ddl) }));
    const { order } = postgresTemplates(items);
    expect(order.map((o) => o.exportName).indexOf("appFdw")).toBeLessThan(order.map((o) => o.exportName).indexOf("appRemote"));
    expect(order.map((o) => o.exportName).indexOf("auditSchema")).toBeLessThan(order.map((o) => o.exportName).indexOf("appPub"));
    const build = JSON.stringify({ dialect: "postgres", objects: order.map((it) => ({ export: it.exportName, type: it.type, ddl: it.ddl, dependsOn: [] })) });
    const declaredSchema = keyedByQualifiedName(declaredObjects(build).map((d) => ({ key: d.exportName, canonical: d.canonical })));
    expect(diffPgSchemas(pgSchemaFromLive(liveObjects(), "public"), declaredSchema).changes).toEqual([]);
  });
});

describe("the kinds that stay refused", () => {
  test("a user mapping and a subscription say why: they carry credentials", () => {
    expect(kindRow("postgres", "user mapping")).toMatchObject({ status: "refused", reason: expect.stringContaining("password") });
    expect(kindRow("postgres", "subscription")).toMatchObject({ status: "refused", reason: expect.stringContaining("credential") });
  });
});
