/**
 * Extended statistics, foreign data wrappers, foreign servers and
 * publications (#3911), and foreign tables, operator classes and families, and
 * text search configurations and dictionaries (#4406): what the tags parse and
 * refuse, how a change to each is classified and made, how the catalog reader
 * prints each, and the round trip: declare, build, import, plan with no change.
 */

import { describe, expect, test } from "vitest";
import { foreignDataWrapper, foreignServer, foreignTable, func, operator, operatorClass, operatorFamily, publication, schema, SqlTemplateError, statistics, table, textSearchConfiguration, textSearchDictionary } from "./entities";
import { diffObject, keyedByQualifiedName, pgSchemaFromLive, type PgSchemaObject } from "./plan/schema";
import { diffPgSchemas, matchPgObjects } from "./plan/diff";
import { alterSteps, dropStatement } from "./apply/statements";
import { declaredObjects } from "./apply/apply";
import { readLiveSchema, type LivePgObject } from "./live/catalog";
import { parseDictionaryOptions, readDatabaseKinds, readOperators } from "./live/catalog-kinds";
import type { PostgresClient } from "./live/client";
import { objectsToIR, type ImportedPgObject } from "./import/ir";
import { PostgresGenerator, postgresTemplates } from "./import/generator";
import { canonicalPgObject } from "./plan/normalize";
import { liveProps } from "./plan/deep";
import { fakeClient } from "./testing/fake-client";
import { sqlSerializer } from "../serializer";
import type { SerializerResult } from "@intentius/chant/serializer";
import { kindRow } from "../coverage";

const app = schema`CREATE SCHEMA app`;
const props = (o: { props: unknown }) => o.props as Record<string, unknown>;

describe("the tags", () => {
  test("operator: a symbol in a schema, identified by its operand types", () => {
    const eq = func`CREATE FUNCTION ${app}.pair_eq(a int, b int) RETURNS boolean LANGUAGE sql AS 'SELECT a = b'`;
    const op = operator`CREATE OPERATOR ${app}.=== (FUNCTION = ${eq}, LEFTARG = int, RIGHTARG = int, COMMUTATOR = ===, NEGATOR = OPERATOR(app.!==), RESTRICT = eqsel, JOIN = eqjoinsel, HASHES); COMMENT ON OPERATOR ${app}.===(int, int) IS 'Same pair'`;
    expect(op.entityType).toBe("Postgres::Operator");
    expect(op.sqlName).toBe("app.===");
    expect(op.dependsOn).toContain(eq);
    expect(op.props).toMatchObject({ schema: "app", name: "===", leftArg: "int", rightArg: "int", comment: "Same pair" });
    const c = canonicalPgObject(op.entityType, props(op));
    expect(c.signature).toBe("(integer,integer)");
    expect(c.fields.definition).toEqual({ commutator: "app.===", function: "app.pair_eq", hashes: "true", negator: "app.!==", restrict: "eqsel", join: "eqjoinsel" });
    const prefix = operator`CREATE OPERATOR app.@@ (PROCEDURE = app.abs_of, RIGHTARG = int)`;
    expect(canonicalPgObject(prefix.entityType, props(prefix))).toMatchObject({ name: "@@", signature: "(NONE,integer)", fields: { definition: { function: "app.abs_of" } } });
  });

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

  test("a foreign table: its columns with options, CHECK constraints, server and options", () => {
    const replica = foreignServer`CREATE SERVER app_replica FOREIGN DATA WRAPPER app_fdw`;
    const ft = foreignTable`CREATE FOREIGN TABLE ${app}.remote_orders (id int OPTIONS (column_name 'order_id') NOT NULL, status text DEFAULT 'placed', CONSTRAINT status_known CHECK (status IS NOT NULL)) SERVER ${replica} OPTIONS (table_name 'orders'); COMMENT ON FOREIGN TABLE ${app}.remote_orders IS 'Orders'; COMMENT ON COLUMN ${app}.remote_orders.id IS 'The key'`;
    expect(ft.entityType).toBe("Postgres::ForeignTable");
    expect(ft.sqlName).toBe("app.remote_orders");
    expect(ft.dependsOn).toEqual(expect.arrayContaining([app, replica]));
    expect(ft.props).toMatchObject({ schema: "app", name: "remote_orders", serverName: "app_replica", options: { table_name: "orders" }, comment: "Orders" });
    expect(ft.props.columns[0]).toMatchObject({ name: "id", type: "int", notNull: true, options: { column_name: "order_id" }, comment: "The key" });
    expect((ft as unknown as { columns: Record<string, unknown> }).columns).toHaveProperty("status");
    const c = canonicalPgObject(ft.entityType, props(ft));
    expect(c.kind).toBe("foreignTable");
    expect(c.schema).toBe("app");
    expect(c.fields).toMatchObject({ server: "app_replica", options: { table_name: "orders" } });
    expect(c.columns.map((x) => [x.name, x.type, x.notNull, x.default])).toEqual([["id", "integer", true, undefined], ["status", "text", false, "'placed'"]]);
    expect(c.columns[0]!.options).toEqual({ column_name: "order_id" });
    expect(c.constraints).toEqual([expect.objectContaining({ kind: "CHECK", name: "status_known", body: "check status is not null" })]);
  });

  test("operator classes and families: identified by their index method", () => {
    const fam = operatorFamily`CREATE OPERATOR FAMILY ${app}.ints USING btree; COMMENT ON OPERATOR FAMILY ${app}.ints USING btree IS 'Integers'`;
    expect(fam.entityType).toBe("Postgres::OperatorFamily");
    expect(fam.props).toMatchObject({ schema: "app", name: "ints", method: "btree", comment: "Integers" });
    expect(canonicalPgObject(fam.entityType, props(fam))).toMatchObject({ kind: "operatorFamily", schema: "app", name: "ints", signature: " USING btree" });
    const cmp = func`CREATE FUNCTION ${app}.int_cmp(a int, b int) RETURNS int LANGUAGE sql AS 'SELECT 0'`;
    const oc = operatorClass`CREATE OPERATOR CLASS ${app}.int_ops DEFAULT FOR TYPE int USING btree FAMILY ${fam} AS OPERATOR 1 <, OPERATOR 3 pg_catalog.= (int, int), FUNCTION 1 ${cmp}(int, int), OPERATOR 5 > FOR SEARCH`;
    expect(oc.entityType).toBe("Postgres::OperatorClass");
    expect(oc.sqlName).toBe("app.int_ops");
    expect(oc.dependsOn).toEqual(expect.arrayContaining([fam, cmp]));
    expect(oc.props).toMatchObject({ schema: "app", name: "int_ops", default: true, dataType: "int", method: "btree", family: "app.ints" });
    const c = canonicalPgObject(oc.entityType, props(oc));
    expect(c.signature).toBe(" USING btree");
    // Operand types default to the class's type; a bare operator is pg_catalog's or the default schema's; the family is the class's own unless another is named.
    expect(c.fields).toMatchObject({
      default: true,
      dataType: "integer",
      family: "app.ints",
      items: ["operator 1 < (integer,integer)", "operator 3 = (integer,integer)", "operator 5 > (integer,integer)", "function 1 (integer,integer) app.int_cmp(integer,integer)"],
    });
    // The server's printing of a class in a family of its own name is the declaration with no FAMILY.
    const own = operatorClass`CREATE OPERATOR CLASS app.hash_ops FOR TYPE int USING hash AS OPERATOR 1 =, FUNCTION 1 hashint4(int)`;
    const named = operatorClass`CREATE OPERATOR CLASS app.hash_ops FOR TYPE integer USING hash FAMILY app.hash_ops AS OPERATOR 1 pg_catalog.= (integer, integer), FUNCTION 1 (integer, integer) hashint4(integer)`;
    expect(canonicalPgObject(own.entityType, props(own)).fields).toEqual(canonicalPgObject(named.entityType, props(named)).fields);
    expect(canonicalPgObject(own.entityType, props(own)).fields).not.toHaveProperty("family");
    // An ordering operator names the btree family it sorts by; a prefix operator's missing side is NONE; STORAGE is the stored type.
    const gist = operatorClass`CREATE OPERATOR CLASS app.g FOR TYPE point USING gist AS OPERATOR 1 <-> (point, point) FOR ORDER BY pg_catalog.float_ops, OPERATOR 2 @@ (NONE, point), STORAGE box`;
    expect(canonicalPgObject(gist.entityType, props(gist)).fields.items).toEqual(["operator 1 <-> (point,point) for order by float_ops", "operator 2 @@ (NONE,point)", "storage box"]);
  });

  test("a text search dictionary and configuration: options, a parser and the mappings after the CREATE", () => {
    const dict = textSearchDictionary`CREATE TEXT SEARCH DICTIONARY ${app}.shop_stop (TEMPLATE = simple, StopWords = english, Accept = false); COMMENT ON TEXT SEARCH DICTIONARY ${app}.shop_stop IS 'Stop words'`;
    expect(dict.entityType).toBe("Postgres::TextSearchDictionary");
    expect(dict.props).toMatchObject({ schema: "app", name: "shop_stop", template: "simple", options: { stopwords: "english", accept: "false" }, comment: "Stop words" });
    expect(canonicalPgObject(dict.entityType, props(dict)).fields).toMatchObject({ template: "simple", options: { accept: "false", stopwords: "english" } });
    // A quoted value is the same option: the server keeps every value as a string.
    const quoted = textSearchDictionary`CREATE TEXT SEARCH DICTIONARY app.shop_stop (template = pg_catalog.simple, accept = 'false', stopwords = 'english')`;
    expect(canonicalPgObject(quoted.entityType, props(quoted)).fields).toEqual({ template: "simple", options: { accept: "false", stopwords: "english" } });

    const cfg = textSearchConfiguration`CREATE TEXT SEARCH CONFIGURATION ${app}.shop (PARSER = pg_catalog."default");
      ALTER TEXT SEARCH CONFIGURATION ${app}.shop ADD MAPPING FOR asciiword, word WITH ${dict}, english_stem;
      ALTER TEXT SEARCH CONFIGURATION ${app}.shop ADD MAPPING FOR int WITH simple;
      COMMENT ON TEXT SEARCH CONFIGURATION ${app}.shop IS 'Shop search'`;
    expect(cfg.entityType).toBe("Postgres::TextSearchConfiguration");
    expect(cfg.dependsOn).toEqual(expect.arrayContaining([app, dict]));
    expect(cfg.props).toMatchObject({ schema: "app", name: "shop", parser: 'pg_catalog."default"', comment: "Shop search" });
    expect(cfg.props.mappings).toEqual([
      { tokens: ["asciiword", "word"], dictionaries: ["app.shop_stop", "english_stem"] },
      { tokens: ["int"], dictionaries: ["simple"] },
    ]);
    expect(canonicalPgObject(cfg.entityType, props(cfg)).fields).toMatchObject({ parser: '"default"', mappings: { asciiword: ["shop_stop", "english_stem"].map((n, i) => (i === 0 ? "app.shop_stop" : n)), int: ["simple"], word: ["app.shop_stop", "english_stem"] } });
  });

  test("what is refused", () => {
    expect(() => operator`CREATE OPERATOR app.=== (LEFTARG = int, RIGHTARG = int)`).toThrow(/FUNCTION/);
    expect(() => operator`CREATE OPERATOR app.=== (FUNCTION = f, LEFTARG = int, MERGE = true)`).toThrow(/an option of an operator/);
    expect(() => operator`CREATE OPERATOR CLASS c FOR TYPE int USING btree AS OPERATOR 1 <`).toThrow(/use the operatorClass tag/);
    expect(() => operator`CREATE OPERATOR FAMILY f USING btree`).toThrow(/use the operatorFamily tag/);
    expect(() => table`CREATE FOREIGN TABLE app.t (id int) SERVER s`).toThrow(/use the foreignTable tag/);
    expect(() => operator`CREATE OPERATOR app.eq (FUNCTION = f)`).toThrow(/operator's symbol/);
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
    // #4406: what a foreign table, an operator class and a text search object refuse.
    expect(() => foreignTable`CREATE FOREIGN TABLE app.t (id int PRIMARY KEY) SERVER s`).toThrow(/CHECK or NOT NULL, not PRIMARY KEY/);
    expect(() => foreignTable`CREATE FOREIGN TABLE app.t (id int, UNIQUE (id)) SERVER s`).toThrow(/CHECK or NOT NULL, not UNIQUE/);
    expect(() => foreignTable`CREATE FOREIGN TABLE app.t (id int, total int GENERATED ALWAYS AS (id * 2) STORED) SERVER s`).toThrow(/generated column/);
    expect(() => foreignTable`CREATE FOREIGN TABLE app.t (id int, CHECK (id > 0) NOT ENFORCED) SERVER s`).toThrow(/NOT ENFORCED/);
    expect(() => foreignTable`CREATE FOREIGN TABLE app.t (id int) INHERITS (app.p) SERVER s`).toThrow(/INHERITS/);
    expect(() => foreignTable`CREATE FOREIGN TABLE app.t PARTITION OF app.p FOR VALUES IN (1) SERVER s`).toThrow(/PARTITION OF/);
    expect(() => foreignTable`CREATE FOREIGN TABLE app.t (LIKE app.p) SERVER s`).toThrow(/LIKE/);
    expect(() => foreignTable`CREATE FOREIGN TABLE app.t (id int)`).toThrow(/SERVER/);
    expect(() => foreignTable`CREATE FOREIGN TABLE app.t (id int) SERVER s OPTIONS (password 'x')`).toThrow(/holds a credential/);
    expect(() => foreignTable`CREATE FOREIGN TABLE app.t (id int OPTIONS (api_key 'x')) SERVER s`).toThrow(/holds a credential/);
    expect(() => operatorClass`CREATE OPERATOR CLASS app.c FOR TYPE int USING btree AS`).toThrow();
    expect(() => operatorClass`CREATE OPERATOR CLASS app.c FOR TYPE int USING btree AS OPERATOR x <`).toThrow(/strategy or support number/);
    expect(() => operatorClass`CREATE OPERATOR CLASS app.c FOR TYPE int USING btree AS OPERATOR 1 < FOR EVERYTHING`).toThrow(/SEARCH or ORDER BY/);
    expect(() => operatorClass`CREATE OPERATOR CLASS app.c FOR TYPE int USING btree AS FUNCTION 1 f`).toThrow(/argument types/);
    expect(() => operatorClass`CREATE OPERATOR CLASS app.c FOR TYPE int USING btree AS OPERATOR 1 <; COMMENT ON OPERATOR CLASS app.c USING hash IS 'x'`).toThrow(/another index method/);
    expect(() => operatorFamily`CREATE OPERATOR FAMILY app.f`).toThrow(/USING/);
    expect(() => textSearchConfiguration`CREATE TEXT SEARCH CONFIGURATION app.c (COPY = english)`).toThrow(/COPY copies mappings/);
    expect(() => textSearchConfiguration`CREATE TEXT SEARCH CONFIGURATION app.c ()`).toThrow(/PARSER/);
    expect(() => textSearchConfiguration`CREATE TEXT SEARCH CONFIGURATION app.c (PARSER = p); ALTER TEXT SEARCH CONFIGURATION app.other ADD MAPPING FOR word WITH simple`).toThrow(/another configuration/);
    expect(() => textSearchConfiguration`CREATE TEXT SEARCH CONFIGURATION app.c (PARSER = p); ALTER TEXT SEARCH CONFIGURATION app.c ADD MAPPING FOR word WITH simple; ALTER TEXT SEARCH CONFIGURATION app.c ADD MAPPING FOR word WITH english_stem`).toThrow(/mapped twice/);
    expect(() => textSearchConfiguration`CREATE TEXT SEARCH CONFIGURATION app.c (PARSER = p); ALTER TEXT SEARCH CONFIGURATION app.c DROP MAPPING FOR word`).toThrow(/ADD MAPPING/);
    expect(() => textSearchConfiguration`ALTER TEXT SEARCH CONFIGURATION app.c ADD MAPPING FOR word WITH simple`).toThrow(/before any CREATE/);
    expect(() => textSearchDictionary`CREATE TEXT SEARCH DICTIONARY app.d (StopWords = english)`).toThrow(/TEMPLATE/);
    expect(() => textSearchDictionary`CREATE TEXT SEARCH DICTIONARY app.d (TEMPLATE = simple, TEMPLATE = snowball)`).toThrow(/given twice/);
    expect(() => textSearchDictionary`CREATE TEXT SEARCH PARSER app.p (START = f)`).toThrow(/DICTIONARY or CONFIGURATION/);
    expect(() => textSearchDictionary`CREATE TEXT SEARCH CONFIGURATION app.c (PARSER = p)`).toThrow(/use the textSearchConfiguration tag/);
  });
});

// ── Classifying and making changes ─────────────────────────────────────

const live = (type: string, statement: string, extra: Partial<LivePgObject> = {}) => pgSchemaFromLive([{ type, statement, name: "", oid: "1", ...extra } as LivePgObject], "public");
const declared = (type: string, ddl: string): PgSchemaObject[] => keyedByQualifiedName([{ key: "x", canonical: { ...diffObject(type, ddl, "public"), exportName: "x" } }]);
const rules = (type: string, before: string, after: string, extra: Partial<LivePgObject> = {}, major?: number) =>
  diffPgSchemas(live(type, before, extra), declared(type, after), major ? { major } : {}).changes.map((c) => [c.field, c.rule]);

function steps(type: string, liveDdl: string, declaredDdl: string, extra: Partial<LivePgObject> = {}, major = 18): string[] {
  const [obj] = declaredObjects(JSON.stringify({ dialect: "postgres", objects: [{ export: "x", type, ddl: declaredDdl, dependsOn: [] }] }));
  const after = keyedByQualifiedName([{ key: "x", canonical: obj!.canonical }]);
  const before = live(type, liveDdl, extra);
  const m = matchPgObjects(before, after).find((x) => x.kind === "matched")!;
  return alterSteps(obj!, m.before!.canonical, diffPgSchemas(before, after, { major }).changes, { major }).steps.map((s) => s.sql);
}

const OPR = "Postgres::Operator";
const STAT = "Postgres::Statistics";
const FDW = "Postgres::ForeignDataWrapper";
const SRV = "Postgres::ForeignServer";
const PUB = "Postgres::Publication";
const OPC = "Postgres::OperatorClass";
const OPF = "Postgres::OperatorFamily";
const FTB = "Postgres::ForeignTable";
const TSD = "Postgres::TextSearchDictionary";
const TSC = "Postgres::TextSearchConfiguration";

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

  test("an operator is dropped and created: it has no ALTER for its function or operands", () => {
    const O1 = "CREATE OPERATOR app.=== (FUNCTION = app.pair_eq, LEFTARG = integer, RIGHTARG = integer, COMMUTATOR = OPERATOR(app.===), RESTRICT = eqsel)";
    expect(rules(OPR, O1, "CREATE OPERATOR app.=== (LEFTARG = int, RIGHTARG = int, RESTRICT = eqsel, COMMUTATOR = ===, FUNCTION = app.pair_eq)")).toEqual([]);
    // The function is not an attribute ALTER OPERATOR reaches, so a change of it is a drop and a create.
    const F2 = O1.replace("app.pair_eq", "app.pair_eq2");
    expect(rules(OPR, O1, F2)).toEqual([["definition", "SQLPG300"]]);
    expect(rules(OPR, O1, F2, { dependents: ["operator class app.c for access method btree"] })).toEqual([["definition", "SQLPG301"]]);
    const recreate = steps(OPR, O1, F2);
    expect(recreate[0]).toBe("DROP OPERATOR app.===(integer,integer)");
    expect(recreate[1]).toContain("pair_eq2");
    expect(recreate[2]).toMatch(/^COMMENT ON OPERATOR app\.===\(integer,integer\) IS /);
    // Another operand type is another operator, not a change.
    expect(dropStatement("operator", "app", "===", "(NONE,integer)").sql).toBe("DROP OPERATOR app.===(NONE,integer)");
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

  test("an operator's estimators, and from 17 its commutator, negator and flags, are altered in place", () => {
    const O1 = "CREATE OPERATOR app.=== (FUNCTION = app.pair_eq, LEFTARG = integer, RIGHTARG = integer, COMMUTATOR = OPERATOR(app.===), RESTRICT = eqsel)";
    const alter = "ALTER OPERATOR app.===(integer,integer) SET";
    // RESTRICT and JOIN, set, changed or removed, on every major.
    for (const major of [14, 16, 18]) {
      expect(rules(OPR, O1, O1.replace("eqsel", "scalarltsel"), {}, major)).toEqual([["definition.restrict", "SQLPG304"]]);
      expect(rules(OPR, O1, `${O1.slice(0, -1)}, JOIN = eqjoinsel)`, {}, major)).toEqual([["definition.join", "SQLPG304"]]);
    }
    expect(steps(OPR, O1, O1.replace("eqsel", "scalarltsel"))).toEqual([`${alter} (RESTRICT = scalarltsel)`]);
    expect(steps(OPR, O1, O1.replace(", RESTRICT = eqsel", ""))).toEqual([`${alter} (RESTRICT = NONE)`]);
    // Every attribute that changed is one statement; the object's dependents do not matter to it.
    const both = `${O1.replace("eqsel", "scalarltsel").slice(0, -1)}, JOIN = scalarltjoinsel)`;
    expect(rules(OPR, O1, both, { dependents: ["operator class app.c for access method btree"] })).toEqual([["definition.restrict", "SQLPG304"], ["definition.join", "SQLPG304"]]);
    expect(steps(OPR, O1, both)).toEqual([`${alter} (RESTRICT = scalarltsel, JOIN = scalarltjoinsel)`]);
    // 17 added COMMUTATOR, NEGATOR, HASHES and MERGES to ALTER OPERATOR, each only to turn it on or fill it in.
    const negated = `${O1.slice(0, -1)}, NEGATOR = OPERATOR(app.!==), HASHES, MERGES)`;
    for (const major of [17, 18]) {
      expect(rules(OPR, O1, negated, {}, major)).toEqual([["definition.negator", "SQLPG304"], ["definition.hashes", "SQLPG304"], ["definition.merges", "SQLPG304"]]);
    }
    expect(steps(OPR, O1, negated)).toEqual([`${alter} (NEGATOR = OPERATOR(app.!==), HASHES, MERGES)`]);
    expect(steps(OPR, "CREATE OPERATOR app.=== (FUNCTION = app.pair_eq, LEFTARG = integer, RIGHTARG = integer)", O1, {}, 17)).toEqual([`${alter} (RESTRICT = eqsel, COMMUTATOR = OPERATOR(app.===))`]);
    // Before 17 only RESTRICT and JOIN are alterable, so the rest is a drop and a create.
    for (const major of [14, 15, 16]) expect(rules(OPR, O1, negated, {}, major)).toEqual([["definition", "SQLPG300"]]);
    // Never in place: a commutator that is already set, a flag turned off, the function or an operand.
    const other = O1.replace("COMMUTATOR = OPERATOR(app.===)", "COMMUTATOR = OPERATOR(app.====)");
    expect(rules(OPR, O1, other)).toEqual([["definition", "SQLPG300"]]);
    expect(rules(OPR, O1, O1.replace(", COMMUTATOR = OPERATOR(app.===)", ""))).toEqual([["definition", "SQLPG300"]]);
    expect(rules(OPR, `${O1.slice(0, -1)}, HASHES)`, O1)).toEqual([["definition", "SQLPG300"]]);
    expect(rules(OPR, O1, `${O1.replace("eqsel", "scalarltsel").slice(0, -1)}, HASHES)`.replace("app.pair_eq", "app.other_eq"))).toEqual([["definition", "SQLPG300"]]);
    // A comment still changes in place beside them.
    expect(rules(OPR, O1, `${O1}; COMMENT ON OPERATOR app.===(integer, integer) IS 'x'`)).toEqual([["comment", "SQLPG216"]]);
  });

  test("a text search dictionary's options change in place; its template does not", () => {
    const D1 = "CREATE TEXT SEARCH DICTIONARY app.d (TEMPLATE = simple, StopWords = english)";
    expect(rules(TSD, D1.replace("simple", "pg_catalog.simple").replace("StopWords", "stopwords").replace("english", "'english'"), D1)).toEqual([]);
    const D2 = "CREATE TEXT SEARCH DICTIONARY app.d (TEMPLATE = simple, Accept = false)";
    expect(rules(TSD, D1, D2)).toEqual([["options", "SQLPG305"]]);
    // An option named with no value is removed.
    expect(steps(TSD, D1, D2)).toEqual(["ALTER TEXT SEARCH DICTIONARY app.d (accept = 'false', stopwords)"]);
    expect(steps(TSD, D1, D1.replace("english", "russian"))).toEqual(["ALTER TEXT SEARCH DICTIONARY app.d (stopwords = 'russian')"]);
    const T2 = D1.replace("simple", "snowball");
    expect(rules(TSD, D1, T2)).toEqual([["template", "SQLPG300"]]);
    expect(rules(TSD, D1, T2, { dependents: ["text search configuration app.c"] })).toEqual([["template", "SQLPG301"]]);
    const recreate = steps(TSD, D1, T2);
    expect(recreate[0]).toBe("DROP TEXT SEARCH DICTIONARY app.d");
    expect(recreate[1]).toBe(T2);
    expect(recreate[2]).toMatch(/^COMMENT ON TEXT SEARCH DICTIONARY app\.d IS /);
    expect(dropStatement("textSearchDictionary", "app", "d").sql).toBe("DROP TEXT SEARCH DICTIONARY app.d");
  });

  test("a text search configuration's mappings change in place; its parser does not", () => {
    const add = (verb: string, tokens: string, dicts: string) => `ALTER TEXT SEARCH CONFIGURATION app.c ${verb} MAPPING FOR ${tokens} WITH ${dicts}`;
    const C1 = `CREATE TEXT SEARCH CONFIGURATION app.c (PARSER = pg_catalog."default"); ${add("ADD", "asciiword, word", "english_stem")}; ${add("ADD", "int", "simple")}`;
    // What the server prints: the parser without pg_catalog, the dictionaries as the catalog names them.
    expect(rules(TSC, `CREATE TEXT SEARCH CONFIGURATION app.c (PARSER = "default");\n${add("ADD", "word, asciiword", "pg_catalog.english_stem")};\n${add("ADD", "int", "public.simple")}`, C1)).toEqual([]);
    const C2 = `CREATE TEXT SEARCH CONFIGURATION app.c (PARSER = pg_catalog."default"); ${add("ADD", "asciiword", "english_stem")}; ${add("ADD", "word", "app.d, english_stem")}; ${add("ADD", "uint", "simple")}`;
    expect(rules(TSC, C1, C2)).toEqual([["mappings", "SQLPG305"]]);
    expect(steps(TSC, C1, C2)).toEqual([
      'ALTER TEXT SEARCH CONFIGURATION app.c DROP MAPPING FOR "int"',
      "ALTER TEXT SEARCH CONFIGURATION app.c ALTER MAPPING FOR word WITH app.d, english_stem",
      "ALTER TEXT SEARCH CONFIGURATION app.c ADD MAPPING FOR uint WITH simple",
    ]);
    // Token types that share their dictionaries share a statement.
    expect(steps(TSC, "CREATE TEXT SEARCH CONFIGURATION app.c (PARSER = \"default\")", C1)).toEqual([
      "ALTER TEXT SEARCH CONFIGURATION app.c ADD MAPPING FOR asciiword, word WITH english_stem",
      'ALTER TEXT SEARCH CONFIGURATION app.c ADD MAPPING FOR "int" WITH simple',
    ]);
    const P2 = C1.replace('pg_catalog."default"', "app.my_parser");
    expect(rules(TSC, C1, P2)).toEqual([["parser", "SQLPG300"]]);
    expect(rules(TSC, C1, P2, { dependents: ["index app.docs_idx"] })).toEqual([["parser", "SQLPG301"]]);
    expect(steps(TSC, C1, P2).slice(0, 2)).toEqual(["DROP TEXT SEARCH CONFIGURATION app.c", `CREATE TEXT SEARCH CONFIGURATION app.c (PARSER = app.my_parser)`]);
    expect(dropStatement("textSearchConfiguration", "app", "c").sql).toBe("DROP TEXT SEARCH CONFIGURATION app.c");
  });

  test("an operator class is dropped and created: ALTER OPERATOR CLASS renames and moves it only", () => {
    const K1 = "CREATE OPERATOR CLASS app.c FOR TYPE integer USING hash AS OPERATOR 1 =, FUNCTION 1 hashint4(integer)";
    // The server prints every operand type, the operator's schema and the family when it is not the class's own.
    const printed = "CREATE OPERATOR CLASS app.c FOR TYPE integer USING hash AS\n    OPERATOR 1 pg_catalog.= (integer, integer),\n    FUNCTION 1 (integer, integer) hashint4(integer)";
    expect(rules(OPC, printed, K1)).toEqual([]);
    expect(rules(OPC, printed, K1.replace("CLASS app.c", "CLASS app.c DEFAULT"))).toEqual([["default", "SQLPG300"]]);
    expect(rules(OPC, printed, K1.replace("AS OPERATOR 1 =", "FAMILY app.f AS OPERATOR 1 ="))).toEqual([["family", "SQLPG300"]]);
    expect(rules(OPC, printed, K1.replace("hashint4(integer)", "hashint4extended(integer, bigint)"))).toEqual([["items", "SQLPG300"]]);
    expect(rules(OPC, printed, K1.replace("hashint4(integer)", "hashint4extended(integer, bigint)"), { dependents: ["index app.docs_idx"] })).toEqual([["items", "SQLPG301"]]);
    const recreate = steps(OPC, printed, K1.replace("CLASS app.c", "CLASS app.c DEFAULT"));
    expect(recreate[0]).toBe("DROP OPERATOR CLASS app.c USING hash");
    expect(recreate[1]).toContain("CREATE OPERATOR CLASS app.c DEFAULT FOR TYPE");
    expect(recreate[2]).toMatch(/^COMMENT ON OPERATOR CLASS app\.c USING hash IS /);
    expect(dropStatement("operatorClass", "app", "c", " USING hash").sql).toBe("DROP OPERATOR CLASS app.c USING hash");
  });

  test("an operator family has its name, method and comment", () => {
    expect(rules(OPF, "CREATE OPERATOR FAMILY app.f USING btree", "CREATE OPERATOR FAMILY app.f USING btree")).toEqual([]);
    expect(steps(OPF, "CREATE OPERATOR FAMILY app.f USING btree", "CREATE OPERATOR FAMILY app.f USING btree; COMMENT ON OPERATOR FAMILY app.f USING btree IS 'x'")).toEqual([expect.stringMatching(/^COMMENT ON OPERATOR FAMILY app\.f USING btree IS 'x/)]);
    expect(dropStatement("operatorFamily", "app", "f", " USING btree").sql).toBe("DROP OPERATOR FAMILY app.f USING btree");
    // The same name for another method is another family, not a change.
    const [a] = declared(OPF, "CREATE OPERATOR FAMILY app.f USING btree");
    const [b] = declared(OPF, "CREATE OPERATOR FAMILY app.f USING hash");
    expect(a!.key).not.toBe(b!.key);
  });

  test("a foreign table is altered in place, except for its server", () => {
    const F1 = "CREATE FOREIGN TABLE app.r (id integer NOT NULL, status text, old text) SERVER s OPTIONS (table_name 'orders')";
    // The server prints the default cast and the doubled parentheses; a column is its type, options and NOT NULL.
    expect(rules(FTB, "CREATE FOREIGN TABLE app.r (\n    id integer NOT NULL,\n    status text DEFAULT 'new'::text,\n    CONSTRAINT k CHECK ((id > 0))\n) SERVER s", "CREATE FOREIGN TABLE app.r (id int NOT NULL, status text DEFAULT 'new', CHECK (id > 0)) SERVER s")).toEqual([]);
    const F2 =
      "CREATE FOREIGN TABLE app.r (id integer, status character varying(10) DEFAULT 'new' CHECK (status <> ''), total numeric OPTIONS (column_name 't')) SERVER s OPTIONS (table_name 'orders2', schema_name 'x')";
    expect(rules(FTB, F1, F2)).toEqual([
      ["columns.old", "SQLPG306"],
      ["columns.id.notNull", "SQLPG306"],
      ["columns.status.type", "SQLPG306"],
      ["columns.status.default", "SQLPG306"],
      ["columns.total", "SQLPG306"],
      ["constraints.check", "SQLPG306"],
      ["options", "SQLPG306"],
    ]);
    expect(steps(FTB, F1, F2)).toEqual([
      "ALTER FOREIGN TABLE app.r DROP COLUMN old",
      "ALTER FOREIGN TABLE app.r ALTER COLUMN id DROP NOT NULL",
      "ALTER FOREIGN TABLE app.r ALTER COLUMN status TYPE character varying(10)",
      "ALTER FOREIGN TABLE app.r ALTER COLUMN status SET DEFAULT 'new'",
      "ALTER FOREIGN TABLE app.r ADD COLUMN total numeric",
      "ALTER FOREIGN TABLE app.r ALTER COLUMN total OPTIONS (ADD column_name 't')",
      "ALTER FOREIGN TABLE app.r ADD CHECK (status <> '')",
      "ALTER FOREIGN TABLE app.r OPTIONS (ADD schema_name 'x', SET table_name 'orders2')",
    ]);
    // A column option, a dropped constraint and a dropped default.
    const G1 = "CREATE FOREIGN TABLE app.r (id integer OPTIONS (column_name 'a') DEFAULT 1, CONSTRAINT pos CHECK (id > 0)) SERVER s";
    const G2 = "CREATE FOREIGN TABLE app.r (id integer OPTIONS (column_name 'b')) SERVER s";
    expect(steps(FTB, G1, G2)).toEqual([
      "ALTER FOREIGN TABLE app.r ALTER COLUMN id SET DEFAULT 1".replace("SET DEFAULT 1", "DROP DEFAULT"),
      "ALTER FOREIGN TABLE app.r ALTER COLUMN id OPTIONS (SET column_name 'b')",
      "ALTER FOREIGN TABLE app.r DROP CONSTRAINT pos",
    ]);
    // ALTER FOREIGN TABLE has no SERVER action.
    const S2 = F1.replace(" SERVER s ", " SERVER s2 ");
    expect(rules(FTB, F1, S2)).toEqual([["server", "SQLPG300"]]);
    expect(rules(FTB, F1, S2, { dependents: ["view app.v"] })).toEqual([["server", "SQLPG301"]]);
    expect(steps(FTB, F1, S2).slice(0, 2)).toEqual(["DROP FOREIGN TABLE app.r", S2]);
    expect(dropStatement("foreignTable", "app", "r").sql).toBe("DROP FOREIGN TABLE app.r");
    // A column's comment and the table's go through COMMENT ON.
    expect(steps(FTB, F1, `${F1}; COMMENT ON COLUMN app.r.status IS 'State'`)).toEqual(["COMMENT ON COLUMN app.r.status IS 'State'"]);
  });

  test("a comment changes in place", () => {
    expect(steps(SRV, "CREATE SERVER s FOREIGN DATA WRAPPER w", "CREATE SERVER s FOREIGN DATA WRAPPER w; COMMENT ON SERVER s IS 'x'")).toEqual([expect.stringMatching(/^COMMENT ON SERVER s IS 'x/)]);
    expect(steps(PUB, "CREATE PUBLICATION p", "CREATE PUBLICATION p; COMMENT ON PUBLICATION p IS 'x'")).toEqual([expect.stringMatching(/^COMMENT ON PUBLICATION p IS 'x/)]);
  });
});

// ── Reading the catalog ────────────────────────────────────────────────

/** Answers the database-kind reader's queries from rows, by the catalog each reads. */
function catalogClient(rows: {
  stats?: unknown[];
  wrappers?: unknown[];
  servers?: unknown[];
  pubs?: unknown[];
  pubTables?: unknown[];
  pubSchemas?: unknown[];
  version15?: boolean;
  classes?: unknown[];
  families?: unknown[];
  dictionaries?: unknown[];
  configurations?: unknown[];
  foreignTables?: unknown[];
  foreignColumns?: unknown[];
  foreignChecks?: unknown[];
}): PostgresClient {
  return {
    async query<T>(sql: string): Promise<T[]> {
      const r = (x: unknown[] | undefined) => (x ?? []) as T[];
      if (sql.includes("pg_get_statisticsobjdef")) return r(rows.stats);
      if (sql.includes("FROM pg_catalog.pg_foreign_data_wrapper w")) return r(rows.wrappers);
      if (sql.includes("FROM pg_catalog.pg_foreign_server v")) return r(rows.servers);
      if (sql.includes("FROM pg_catalog.pg_publication p")) return r(rows.pubs);
      if (sql.includes("FROM pg_catalog.pg_publication_rel r")) return r(rows.pubTables);
      if (sql.includes("FROM pg_catalog.pg_publication_namespace pn")) return r(rows.pubSchemas);
      if (sql.includes("FROM pg_catalog.pg_opfamily f JOIN")) return r(rows.families);
      if (sql.includes("FROM pg_catalog.pg_opclass c JOIN pg_catalog.pg_namespace n ON n.oid = c.opcnamespace")) return r(rows.classes);
      if (sql.includes("FROM pg_catalog.pg_ts_config c JOIN pg_catalog.pg_namespace n ON n.oid = c.cfgnamespace")) return r(rows.configurations);
      if (sql.includes("FROM pg_catalog.pg_ts_dict d JOIN pg_catalog.pg_namespace n ON n.oid = d.dictnamespace")) return r(rows.dictionaries);
      if (sql.includes("JOIN pg_catalog.pg_foreign_table ft ON ft.ftrelid = c.oid")) return r(rows.foreignTables);
      if (sql.includes("FROM pg_catalog.pg_attribute AS a JOIN pg_catalog.pg_type t ON t.oid = a.atttypid\n     LEFT JOIN")) return r(rows.foreignColumns);
      if (sql.includes("FROM pg_catalog.pg_constraint k")) return r(rows.foreignChecks);
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

  test("an operator: its operands, its commutator and its flags, as the catalog holds them", async () => {
    const client: PostgresClient = {
      async query<T>(sql: string): Promise<T[]> {
        if (!sql.includes("FROM pg_catalog.pg_operator o")) return [];
        return [
          { oid: "1", schema: "app", name: "===", leftarg: "integer", rightarg: "integer", func: "app.pair_eq", commutator: "OPERATOR(app.===)", negator: null, restrict: "eqsel", join_func: null, hashes: true, merges: false, comment: "Same", dependents: ["operator class app.c"] },
          { oid: "2", schema: "app", name: "@@", leftarg: null, rightarg: "integer", func: "app.abs_of", commutator: null, negator: null, restrict: null, join_func: null, hashes: false, merges: false, comment: null, dependents: [] },
        ] as T[];
      },
      async end() {},
    };
    const ops = await readOperators(client, {});
    expect(ops.map((o) => [o.schema, o.name, o.signature])).toEqual([["app", "===", "(integer,integer)"], ["app", "@@", "(NONE,integer)"]]);
    expect(ops[0]!.statement).toBe(
      "CREATE OPERATOR app.=== (FUNCTION = app.pair_eq, LEFTARG = integer, RIGHTARG = integer, COMMUTATOR = OPERATOR(app.===), RESTRICT = eqsel, HASHES);\nCOMMENT ON OPERATOR app.===(integer,integer) IS 'Same'",
    );
    expect(ops[0]!.dependents).toEqual(["operator class app.c"]);
    expect(ops[1]!.statement).toBe("CREATE OPERATOR app.@@ (FUNCTION = app.abs_of, RIGHTARG = integer)");
    for (const o of ops) expect(() => liveProps(o)).not.toThrow();
  });

  test("operator classes and families: a class carries its members, its own family is its own", async () => {
    const objects = await readDatabaseKinds(
      catalogClient({
        classes: [
          {
            oid: "10", schema: "app", name: "int_hash_ops", method: "hash", isdefault: false, type: "integer", storage: null, family: null,
            operators: ["OPERATOR 1 pg_catalog.= (integer, integer)"], functions: ["FUNCTION 1 (integer, integer) hashint4(integer)"], comment: "Hash by value", dependents: ["index app.users_idx"],
          },
          {
            oid: "11", schema: "app", name: "box_ops", method: "gist", isdefault: true, type: "box", storage: "box", family: 'app."My Family"',
            operators: ["OPERATOR 1 pg_catalog.<<(box, box)".replace("<<(box", "<< (box")], functions: [], comment: null, dependents: [],
          },
          { oid: "12", schema: "app", name: "empty_ops", method: "hash", isdefault: false, type: "integer", storage: null, family: null, operators: [], functions: [], comment: null, dependents: [] },
        ],
        families: [
          { oid: "20", schema: "app", name: "spare_ops", method: "btree", loose: 2, comment: "Spare", dependents: [] },
          { oid: "21", schema: "app", name: "plain_ops", method: "btree", loose: 0, comment: null, dependents: [] },
        ],
      }),
      {},
    );
    const [hash, box, empty, spare, plain] = objects;
    expect(objects.map((o) => [o.type, o.name, o.signature])).toEqual([
      [OPC, "int_hash_ops", " USING hash"],
      [OPC, "box_ops", " USING gist"],
      [OPC, "empty_ops", " USING hash"],
      [OPF, "spare_ops", " USING btree"],
      [OPF, "plain_ops", " USING btree"],
    ]);
    expect(hash!.statement).toBe(
      "CREATE OPERATOR CLASS app.int_hash_ops FOR TYPE integer USING hash AS\n    OPERATOR 1 pg_catalog.= (integer, integer),\n    FUNCTION 1 (integer, integer) hashint4(integer);\nCOMMENT ON OPERATOR CLASS app.int_hash_ops USING hash IS 'Hash by value'",
    );
    expect(hash!.dependents).toEqual(["index app.users_idx"]);
    expect(box!.statement).toBe('CREATE OPERATOR CLASS app.box_ops DEFAULT FOR TYPE box USING gist FAMILY app."My Family" AS\n    OPERATOR 1 pg_catalog.<< (box, box),\n    STORAGE box');
    // A class whose members could not be read is not declared half.
    expect(empty!.unsupported).toMatch(/at least one/);
    expect(spare!.statement).toBe("CREATE OPERATOR FAMILY app.spare_ops USING btree;\nCOMMENT ON OPERATOR FAMILY app.spare_ops USING btree IS 'Spare'");
    expect(spare!.warnings).toEqual(["2 loose members added with ALTER OPERATOR FAMILY ... ADD are left out; a declaration holds the family and its classes' members"]);
    expect(plain!.warnings).toBeUndefined();
    for (const o of [hash!, box!, spare!, plain!]) expect(() => liveProps(o)).not.toThrow();
    expect(liveProps(box!)).toMatchObject({ default: true, family: 'app."My Family"', items: [{ kind: "operator" }, { kind: "storage", type: "box" }] });
  });

  test("text search: a dictionary's options as the server writes them, a configuration's mappings grouped by dictionaries", async () => {
    const objects = await readDatabaseKinds(
      catalogClient({
        dictionaries: [
          { oid: "30", schema: "app", name: "shop_stop", template: "simple", init: "stopwords = 'english', accept = 'false'", comment: "It's stop words", dependents: ["text search configuration app.shop"] },
          { oid: "31", schema: "app", name: "bare", template: "app.my_template", init: null, comment: null, dependents: [] },
          { oid: "32", schema: "app", name: "odd", template: "simple", init: "this is not a list", comment: null, dependents: [] },
        ],
        configurations: [
          {
            oid: "40", schema: "app", name: "shop", parser: '"default"', comment: "Shop search", dependents: ["index app.docs_idx"],
            mappings: ["asciiword\tapp.shop_stop, english_stem", "word\tapp.shop_stop, english_stem", "int\tsimple"],
          },
          { oid: "41", schema: "app", name: "nothing", parser: '"default"', comment: null, mappings: [], dependents: [] },
        ],
      }),
      {},
    );
    const [stop, bare, odd, shop, nothing] = objects;
    expect(objects.map((o) => [o.type, o.name])).toEqual([[TSD, "shop_stop"], [TSD, "bare"], [TSD, "odd"], [TSC, "shop"], [TSC, "nothing"]]);
    expect(stop!.statement).toBe("CREATE TEXT SEARCH DICTIONARY app.shop_stop (TEMPLATE = simple, stopwords = 'english', accept = 'false');\nCOMMENT ON TEXT SEARCH DICTIONARY app.shop_stop IS 'It''s stop words'");
    expect(stop!.dependents).toEqual(["text search configuration app.shop"]);
    expect(bare!.statement).toBe("CREATE TEXT SEARCH DICTIONARY app.bare (TEMPLATE = app.my_template)");
    expect(odd!.unsupported).toMatch(/not in the form the server writes/);
    expect(shop!.statement).toBe(
      [
        'CREATE TEXT SEARCH CONFIGURATION app.shop (PARSER = "default")',
        "ALTER TEXT SEARCH CONFIGURATION app.shop ADD MAPPING FOR asciiword, word WITH app.shop_stop, english_stem",
        'ALTER TEXT SEARCH CONFIGURATION app.shop ADD MAPPING FOR "int" WITH simple',
        "COMMENT ON TEXT SEARCH CONFIGURATION app.shop IS 'Shop search'",
      ].join(";\n"),
    );
    expect(nothing!.statement).toBe('CREATE TEXT SEARCH CONFIGURATION app.nothing (PARSER = "default")');
    for (const o of [stop!, bare!, shop!, nothing!]) expect(() => liveProps(o)).not.toThrow();
    expect(liveProps(shop!).mappings).toEqual([{ tokens: ["asciiword", "word"], dictionaries: ["app.shop_stop", "english_stem"] }, { tokens: ["int"], dictionaries: ["simple"] }]);
    expect(parseDictionaryOptions("Language = 'it''s', \"Odd Name\" = 'a\\\\b'")).toEqual([["Language", "it's"], ["Odd Name", "a\\b"]]);
    expect(parseDictionaryOptions(undefined)).toEqual([]);
    expect(parseDictionaryOptions("language")).toBeUndefined();
  });

  test("foreign tables: columns with their options, checks, server and options; a credential is left out; a partition, an inheriting table and a generated column are not declarable", async () => {
    const objects = await readDatabaseKinds(
      catalogClient({
        foreignTables: [
          { oid: "50", schema: "app", name: "remote_orders", ispartition: false, inherits: false, server: "app_replica", options: ["table_name=orders", "password=hunter2"], comment: "Orders", dependents: ["view app.order_view"] },
          { oid: "51", schema: "app", name: "remote_part", ispartition: true, inherits: false, server: "app_replica", options: null, comment: null, dependents: [] },
          { oid: "52", schema: "app", name: "remote_child", ispartition: false, inherits: true, server: "app_replica", options: null, comment: null, dependents: [] },
          { oid: "53", schema: "app", name: "remote_gen", ispartition: false, inherits: false, server: "app_replica", options: null, comment: null, dependents: [] },
        ],
        foreignColumns: [
          { rel: "50", name: "id", type: "integer", notnull: true, generated: "", dflt: null, collation: null, options: ["column_name=order_id", "sslpassword=x"], comment: "The key" },
          { rel: "50", name: "status", type: "text", notnull: false, generated: "", dflt: "'placed'::text", collation: '"C"', options: null, comment: null },
          { rel: "51", name: "id", type: "integer", notnull: false, generated: "", dflt: null, collation: null, options: null, comment: null },
          { rel: "52", name: "id", type: "integer", notnull: false, generated: "", dflt: null, collation: null, options: null, comment: null },
          { rel: "53", name: "id", type: "integer", notnull: false, generated: "s", dflt: "1", collation: null, options: null, comment: null },
        ],
        foreignChecks: [{ rel: "50", name: "status_known", def: "CHECK ((status IS NOT NULL))", comment: "Always set" }],
      }),
      {},
    );
    expect(objects.map((o) => [o.type, o.name])).toEqual([[FTB, "remote_orders"], [FTB, "remote_part"], [FTB, "remote_child"], [FTB, "remote_gen"]]);
    const [orders, part, child, gen] = objects;
    expect(orders!.statement).toBe(
      [
        "CREATE FOREIGN TABLE app.remote_orders (\n    id integer OPTIONS (column_name 'order_id') NOT NULL,\n    status text COLLATE \"C\" DEFAULT 'placed'::text,\n    CONSTRAINT status_known CHECK ((status IS NOT NULL))\n) SERVER app_replica OPTIONS (table_name 'orders')",
        "COMMENT ON FOREIGN TABLE app.remote_orders IS 'Orders'",
        "COMMENT ON COLUMN app.remote_orders.id IS 'The key'",
        "COMMENT ON CONSTRAINT status_known ON app.remote_orders IS 'Always set'",
      ].join(";\n"),
    );
    expect(orders!.warnings).toEqual(["the options sslpassword, password hold a credential and are left out; the environment supplies it"]);
    expect(orders!.dependents).toEqual(["view app.order_view"]);
    expect(part!.unsupported).toMatch(/partition/);
    expect(child!.unsupported).toMatch(/inherits/);
    expect(gen!.unsupported).toMatch(/generated column/);
    expect(liveProps(orders!)).toMatchObject({ serverName: "app_replica", options: { table_name: "orders" }, columns: [{ name: "id", options: { column_name: "order_id" } }, { name: "status", collate: '"C"' }], checks: [{ name: "status_known" }] });
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
const SERVER_PRINTS: Array<{ type: string; schema?: string; name: string; signature?: string; statement: string }> = [
  { type: "Postgres::Schema", name: "app", statement: "CREATE SCHEMA app" },
  { type: "Postgres::Schema", name: "audit", statement: "CREATE SCHEMA audit" },
  { type: "Postgres::Table", schema: "app", name: "orders", statement: "CREATE TABLE app.orders (\n    id integer,\n    status text\n)" },
  { type: "Postgres::Function", schema: "app", name: "pair_eq", signature: "(integer,integer)", statement: "CREATE FUNCTION app.pair_eq(a integer, b integer)\n RETURNS boolean\n LANGUAGE sql\nAS $function$SELECT a = b$function$" },
  { type: OPR, schema: "app", name: "===", signature: "(integer,integer)", statement: "CREATE OPERATOR app.=== (FUNCTION = app.pair_eq, LEFTARG = integer, RIGHTARG = integer, COMMUTATOR = OPERATOR(app.===), HASHES);\nCOMMENT ON OPERATOR app.===(integer,integer) IS 'Same pair'" },
  { type: STAT, schema: "app", name: "orders_stats", statement: "CREATE STATISTICS app.orders_stats (dependencies) ON id, status FROM app.orders;\nCOMMENT ON STATISTICS app.orders_stats IS 'Correlated'" },
  { type: FDW, name: "app_fdw", statement: "CREATE FOREIGN DATA WRAPPER app_fdw OPTIONS (debug 'true');\nCOMMENT ON FOREIGN DATA WRAPPER app_fdw IS 'Remote'" },
  { type: SRV, name: "app_remote", statement: "CREATE SERVER app_remote TYPE 'pg' VERSION '16' FOREIGN DATA WRAPPER app_fdw OPTIONS (host 'db.internal', port '5432')" },
  { type: PUB, name: "app_pub", statement: "CREATE PUBLICATION app_pub FOR TABLE app.orders (id, status) WHERE (id > 0), TABLES IN SCHEMA audit WITH (publish = 'insert, update')" },
  {
    type: FTB,
    schema: "app",
    name: "remote_orders",
    statement:
      "CREATE FOREIGN TABLE app.remote_orders (\n    id integer OPTIONS (column_name 'order_id') NOT NULL,\n    status text DEFAULT 'placed'::text,\n    CONSTRAINT status_known CHECK ((status IS NOT NULL))\n) SERVER app_remote OPTIONS (table_name 'orders');\nCOMMENT ON FOREIGN TABLE app.remote_orders IS 'Orders on the replica'",
  },
  {
    type: OPC,
    schema: "app",
    name: "int_hash_ops",
    signature: " USING hash",
    statement:
      "CREATE OPERATOR CLASS app.int_hash_ops FOR TYPE integer USING hash AS\n    OPERATOR 1 pg_catalog.= (integer, integer),\n    FUNCTION 1 (integer, integer) hashint4(integer);\nCOMMENT ON OPERATOR CLASS app.int_hash_ops USING hash IS 'Hash by value'",
  },
  { type: OPF, schema: "app", name: "spare_ops", signature: " USING btree", statement: "CREATE OPERATOR FAMILY app.spare_ops USING btree" },
  { type: TSD, schema: "app", name: "shop_stop", statement: "CREATE TEXT SEARCH DICTIONARY app.shop_stop (TEMPLATE = simple, stopwords = 'english')" },
  {
    type: TSC,
    schema: "app",
    name: "shop",
    statement:
      'CREATE TEXT SEARCH CONFIGURATION app.shop (PARSER = "default");\nALTER TEXT SEARCH CONFIGURATION app.shop ADD MAPPING FOR asciiword, word WITH app.shop_stop, english_stem;\nALTER TEXT SEARCH CONFIGURATION app.shop ADD MAPPING FOR "int" WITH simple;\nCOMMENT ON TEXT SEARCH CONFIGURATION app.shop IS \'Shop search\'',
  },
];

describe("declare, build, import, plan with no change", () => {
  const liveObjects = (): LivePgObject[] => SERVER_PRINTS.map((o, i) => ({ oid: String(i), ...o }) as LivePgObject);

  test("a declaration the server prints back plans with no change", () => {
    const orders = table`CREATE TABLE ${app}.orders (id int, status text)`;
    const audit = schema`CREATE SCHEMA audit`;
    const fdw = foreignDataWrapper`CREATE FOREIGN DATA WRAPPER app_fdw OPTIONS (debug 'true'); COMMENT ON FOREIGN DATA WRAPPER app_fdw IS 'Remote'`;
    const pairEq = func`CREATE FUNCTION ${app}.pair_eq(a integer, b integer) RETURNS boolean LANGUAGE sql AS 'SELECT a = b'`;
    const remote = foreignServer`CREATE SERVER app_remote TYPE 'pg' VERSION '16' FOREIGN DATA WRAPPER ${fdw} OPTIONS (port '5432', host 'db.internal')`;
    const shopStop = textSearchDictionary`CREATE TEXT SEARCH DICTIONARY ${app}.shop_stop (TEMPLATE = simple, StopWords = english)`;
    const objects = [
      app,
      audit,
      orders,
      pairEq,
      operator`CREATE OPERATOR ${app}.=== (LEFTARG = int, RIGHTARG = int, FUNCTION = ${pairEq}, HASHES, COMMUTATOR = ===); COMMENT ON OPERATOR ${app}.===(int, int) IS 'Same pair'`,
      statistics`CREATE STATISTICS ${app}.orders_stats (dependencies) ON status, id FROM ${orders}; COMMENT ON STATISTICS ${app}.orders_stats IS 'Correlated'`,
      fdw,
      remote,
      publication`CREATE PUBLICATION app_pub FOR TABLE ${orders} (status, id) WHERE (id > 0), TABLES IN SCHEMA ${audit} WITH (publish = 'update, insert')`,
      foreignTable`CREATE FOREIGN TABLE ${app}.remote_orders (id int OPTIONS (column_name 'order_id') NOT NULL, status text DEFAULT 'placed', CONSTRAINT status_known CHECK (status IS NOT NULL)) SERVER ${remote} OPTIONS (table_name 'orders'); COMMENT ON FOREIGN TABLE ${app}.remote_orders IS 'Orders on the replica'`,
      operatorClass`CREATE OPERATOR CLASS ${app}.int_hash_ops FOR TYPE int USING hash AS OPERATOR 1 =, FUNCTION 1 hashint4(int); COMMENT ON OPERATOR CLASS ${app}.int_hash_ops USING hash IS 'Hash by value'`,
      operatorFamily`CREATE OPERATOR FAMILY ${app}.spare_ops USING btree`,
      shopStop,
      textSearchConfiguration`CREATE TEXT SEARCH CONFIGURATION ${app}.shop (PARSER = pg_catalog.default);
        ALTER TEXT SEARCH CONFIGURATION ${app}.shop ADD MAPPING FOR word, asciiword WITH ${shopStop}, english_stem;
        ALTER TEXT SEARCH CONFIGURATION ${app}.shop ADD MAPPING FOR int WITH simple;
        COMMENT ON TEXT SEARCH CONFIGURATION ${app}.shop IS 'Shop search'`,
    ];
    // The build: each entity's DDL, rendered, as the build output holds it.
    const build = JSON.stringify({ dialect: "postgres", objects: objects.map((o, i) => ({ export: `o${i}`, type: o.entityType, ddl: (o.props as { ddl: string }).ddl, dependsOn: [] })) });
    const declaredSchema = keyedByQualifiedName(declaredObjects(build).map((d) => ({ key: d.exportName, canonical: d.canonical })));
    expect(diffPgSchemas(pgSchemaFromLive(liveObjects(), "public"), declaredSchema).changes).toEqual([]);
  });

  test("import writes each as a declaration, which builds to the same objects", () => {
    const ir = objectsToIR(SERVER_PRINTS.map((o) => ({ type: o.type, ...(o.schema ? { schema: o.schema } : {}), name: o.name, ddl: o.statement }) as ImportedPgObject));
    const [file] = new PostgresGenerator().generate(ir);
    const content = file!.content;
    expect(content).toContain(
      'import { foreignDataWrapper, foreignServer, foreignTable, func, operator, operatorClass, operatorFamily, publication, schema, statistics, table, textSearchConfiguration, textSearchDictionary } from "@intentius/chant-lexicon-sql/postgres";',
    );
    expect(content).toContain("export const ordersStats = statistics`");
    expect(content).toContain("export const pairEq = func`");
    expect(content).toContain("CREATE OPERATOR ${appSchema}.=== (FUNCTION = ${pairEq}, LEFTARG = integer");
    expect(content).toContain("CREATE STATISTICS ${appSchema}.orders_stats (dependencies) ON id, status FROM ${orders}");
    expect(content).toContain("export const appFdw = foreignDataWrapper`");
    expect(content).toContain("FOREIGN DATA WRAPPER ${appFdw} OPTIONS (host 'db.internal'");
    expect(content).toContain("export const appPub = publication`");
    expect(content).toContain("TABLES IN SCHEMA ${auditSchema} WITH (publish = 'insert, update')");
    expect(content).toContain("FOR TABLE ${orders} (id, status) WHERE (id > 0)");
    // #4406: a foreign table names its server, a configuration its dictionary, by export.
    expect(content).toContain("export const remoteOrders = foreignTable`");
    expect(content).toContain(") SERVER ${appRemote} OPTIONS (table_name 'orders')");
    expect(content).toContain("export const intHashOps = operatorClass`");
    expect(content).toContain("export const spareOps = operatorFamily`");
    expect(content).toContain("export const shopStop = textSearchDictionary`");
    expect(content).toContain("ADD MAPPING FOR asciiword, word WITH ${shopStop}, english_stem");
    expect(content).toContain("CREATE TEXT SEARCH CONFIGURATION ${appSchema}.shop (PARSER");

    // The imported statements, in the generator's order, as a build: no change against the objects they came from.
    const items = ir.resources.map((r) => ({ exportName: r.logicalId, type: r.type, ...(r.properties.schema ? { schema: String(r.properties.schema) } : {}), name: String(r.properties.name), ddl: String(r.properties.ddl) }));
    const { order } = postgresTemplates(items);
    expect(order.map((o) => o.exportName).indexOf("appFdw")).toBeLessThan(order.map((o) => o.exportName).indexOf("appRemote"));
    expect(order.map((o) => o.exportName).indexOf("auditSchema")).toBeLessThan(order.map((o) => o.exportName).indexOf("appPub"));
    expect(order.map((o) => o.exportName).indexOf("appRemote")).toBeLessThan(order.map((o) => o.exportName).indexOf("remoteOrders"));
    expect(order.map((o) => o.exportName).indexOf("shopStop")).toBeLessThan(order.map((o) => o.exportName).indexOf("shop"));
    const build = JSON.stringify({ dialect: "postgres", objects: order.map((it) => ({ export: it.exportName, type: it.type, ddl: it.ddl, dependsOn: [] })) });
    const declaredSchema = keyedByQualifiedName(declaredObjects(build).map((d) => ({ key: d.exportName, canonical: d.canonical })));
    expect(diffPgSchemas(pgSchemaFromLive(liveObjects(), "public"), declaredSchema).changes).toEqual([]);
  });
});

describe("the build output", () => {
  test("each new kind is written under its entity type, with its own props beside it", () => {
    const orders = foreignTable`CREATE FOREIGN TABLE app.remote_orders (id int) SERVER replica`;
    const ops = operatorClass`CREATE OPERATOR CLASS app.int_hash_ops FOR TYPE integer USING hash AS OPERATOR 1 =, FUNCTION 1 hashint4(integer)`;
    const family = operatorFamily`CREATE OPERATOR FAMILY app.spare_ops USING btree`;
    const dict = textSearchDictionary`CREATE TEXT SEARCH DICTIONARY app.d (TEMPLATE = simple)`;
    const cfg = textSearchConfiguration`CREATE TEXT SEARCH CONFIGURATION app.c (PARSER = pg_catalog.default); ALTER TEXT SEARCH CONFIGURATION app.c ADD MAPPING FOR word WITH ${dict}`;
    const out = sqlSerializer.serialize(new Map(Object.entries({ orders, ops, family, dict, cfg })) as never, undefined, {}) as SerializerResult;
    const doc = JSON.parse(out.primary) as { objects: Array<Record<string, unknown>> };
    const byExport = Object.fromEntries(doc.objects.map((o) => [o.export, o]));
    expect(byExport.orders).toMatchObject({ type: FTB, sqlName: "app.remote_orders", serverName: "replica" });
    expect(byExport.ops).toMatchObject({ type: OPC, method: "hash", dataType: "integer" });
    expect(byExport.family).toMatchObject({ type: OPF, method: "btree" });
    expect(byExport.dict).toMatchObject({ type: TSD, template: "simple" });
    expect(byExport.cfg).toMatchObject({ type: TSC, parser: "pg_catalog.default", dependsOn: ["dict"] });
    // And the applier reads the objects back from that output.
    expect(declaredObjects(out.primary).map((d) => [d.exportName, d.canonical.kind, d.canonical.signature]).sort((a, b) => String(a[0]).localeCompare(String(b[0])))).toEqual([
      ["cfg", "textSearchConfiguration", undefined],
      ["dict", "textSearchDictionary", undefined],
      ["family", "operatorFamily", " USING btree"],
      ["ops", "operatorClass", " USING hash"],
      ["orders", "foreignTable", undefined],
    ]);
  });
});

describe("the coverage table", () => {
  test("a foreign table, an operator class and family and the two text search kinds are declared; the parser and template stay refused", () => {
    expect(kindRow("postgres", "foreign table")).toMatchObject({ status: "declared", entity: FTB });
    expect(kindRow("postgres", "operator class")).toMatchObject({ status: "declared", entity: OPC });
    expect(kindRow("postgres", "operator family")).toMatchObject({ status: "declared", entity: OPF });
    expect(kindRow("postgres", "text search configuration")).toMatchObject({ status: "declared", entity: TSC });
    expect(kindRow("postgres", "text search dictionary")).toMatchObject({ status: "declared", entity: TSD });
    expect(kindRow("postgres", "text search parser")).toMatchObject({ status: "refused", reason: expect.stringContaining("C code") });
    expect(kindRow("postgres", "text search template")).toMatchObject({ status: "refused", reason: expect.stringContaining("C code") });
  });
});

describe("the kinds that stay refused", () => {
  test("a user mapping and a subscription say why: they carry credentials", () => {
    expect(kindRow("postgres", "user mapping")).toMatchObject({ status: "refused", reason: expect.stringContaining("password") });
    expect(kindRow("postgres", "subscription")).toMatchObject({ status: "refused", reason: expect.stringContaining("credential") });
  });
});
