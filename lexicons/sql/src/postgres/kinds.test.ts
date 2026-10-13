/**
 * Composite and range types, aggregates, collations, casts and event triggers
 * (#3911): what the tags parse and refuse, how a change to each is
 * classified and made, and how an import writes them.
 */

import { describe, expect, test } from "vitest";
import { aggregate, cast, collation, eventTrigger, func, schema, SqlTemplateError, type } from "./entities";
import { diffObject, keyedByQualifiedName, pgSchemaFromLive, type PgSchemaObject } from "./plan/schema";
import { diffPgSchemas, matchPgObjects } from "./plan/diff";
import { alterSteps, dropStatement } from "./apply/statements";
import { declaredObjects } from "./apply/apply";
import type { LivePgObject } from "./live/catalog";
import { objectsToIR } from "./import/ir";
import { PostgresGenerator } from "./import/generator";
import { canonicalPgObject } from "./plan/normalize";

const app = schema`CREATE SCHEMA app`;

describe("the tags", () => {
  test("type declares enum, composite and range types", () => {
    const pair = type`CREATE TYPE ${app}.pair AS (a int, b text COLLATE "C"); COMMENT ON TYPE ${app}.pair IS 'Two'`;
    expect(pair.entityType).toBe("Postgres::CompositeType");
    expect(pair.props).toMatchObject({ schema: "app", name: "pair", attributes: [{ name: "a", type: "int" }, { name: "b", type: "text", collate: '"C"' }], comment: "Two" });
    const range = type`CREATE TYPE ${app}.floatrange AS RANGE (SUBTYPE = float8, SUBTYPE_DIFF = float8mi)`;
    expect(range.entityType).toBe("Postgres::RangeType");
    expect(canonicalPgObject(range.entityType, range.props as unknown as Record<string, unknown>).fields).toMatchObject({ subtype: "double precision", subtypeDiff: "float8mi", multirange: "app.floatmultirange" });
    expect(type`CREATE TYPE ${app}.mood AS ENUM ('ok')`.entityType).toBe("Postgres::Enum");
  });

  test("an aggregate is identified by its argument types; its options compare canonical", () => {
    const add = func`CREATE FUNCTION ${app}.add2(a int, b int) RETURNS int LANGUAGE sql AS $$ SELECT a + b $$`;
    const total = aggregate`CREATE AGGREGATE ${app}.total(int) (SFUNC = ${add}, STYPE = int4, INITCOND = 0, PARALLEL = UNSAFE)`;
    expect(total.dependsOn).toContain(add);
    const c = canonicalPgObject(total.entityType, total.props as unknown as Record<string, unknown>);
    expect(c.signature).toBe("(integer)");
    expect(c.fields.definition).toEqual({ initcond: "0", sfunc: "app.add2", stype: "integer" });
    const median = aggregate`CREATE AGGREGATE app.med(ORDER BY float8) (SFUNC = pg_catalog.array_append, STYPE = float8[])`;
    expect(canonicalPgObject(median.entityType, median.props as unknown as Record<string, unknown>).signature).toBe("(ORDER BY double precision)");
    expect(canonicalPgObject("Postgres::Aggregate", aggregate`CREATE AGGREGATE app.n(*) (SFUNC = int8inc, STYPE = int8)`.props as unknown as Record<string, unknown>).signature).toBe("(*)");
  });

  test("a collation, a cast and an event trigger", () => {
    const ci = collation`CREATE COLLATION ${app}.ci (provider = icu, locale = 'und-u-ks-level2', deterministic = false)`;
    expect(canonicalPgObject(ci.entityType, ci.props as unknown as Record<string, unknown>).fields).toMatchObject({ provider: "icu", locale: "und-u-ks-level2", nondeterministic: true });
    const c2 = collation`CREATE COLLATION app.c2 (LOCALE = 'C')`;
    expect(canonicalPgObject(c2.entityType, c2.props as unknown as Record<string, unknown>).fields).toMatchObject({ provider: "libc", lcCollate: "C", lcCtype: "C" });

    const pair = type`CREATE TYPE ${app}.pair AS (a int)`;
    const k = cast`CREATE CAST (${pair} AS text) WITH INOUT AS ASSIGNMENT; COMMENT ON CAST (${pair} AS text) IS 'x'`;
    expect(k.sqlName).toBe("(app.pair AS text)");
    expect(k.props).toMatchObject({ sourceType: "app.pair", targetType: "text", method: "inout", context: "assignment", comment: "x" });
    expect(k.dependsOn).toEqual([pair]);

    const fn = func`CREATE FUNCTION ${app}.audit() RETURNS event_trigger LANGUAGE plpgsql AS $$ BEGIN END $$`;
    const et = eventTrigger`CREATE EVENT TRIGGER audit ON ddl_command_end WHEN TAG IN ('CREATE TABLE', 'alter table') EXECUTE FUNCTION ${fn}()`;
    expect(canonicalPgObject(et.entityType, et.props as unknown as Record<string, unknown>).fields).toMatchObject({ event: "ddl_command_end", tags: ["ALTER TABLE", "CREATE TABLE"], function: "app.audit" });
  });

  test("what is refused", () => {
    expect(() => type`CREATE TYPE app.later`).toThrow(/shell type/);
    expect(() => type`CREATE TYPE app.t (INPUT = t_in, OUTPUT = t_out)`).toThrow(/base type/);
    expect(() => aggregate`CREATE AGGREGATE app.a (BASETYPE = int, SFUNC = f, STYPE = int)`).toThrow(/old form/);
    expect(() => aggregate`CREATE AGGREGATE app.a(int) (SFUNC = f)`).toThrow(/expected STYPE/);
    expect(() => aggregate`CREATE AGGREGATE app.a(OUT int) (SFUNC = f, STYPE = int)`).toThrow(/IN or VARIADIC/);
    expect(() => collation`CREATE COLLATION app.c FROM "C"`).toThrow(/FROM copies/);
    expect(() => collation`CREATE COLLATION app.c (lokale = 'C')`).toThrow(/an option of a collation/);
    expect(() => type`CREATE TYPE app.r AS RANGE (SUBTYPE_DIFF = f)`).toThrow(/expected SUBTYPE/);
    expect(() => eventTrigger`CREATE EVENT TRIGGER app.e ON ddl_command_end EXECUTE FUNCTION f()`).toThrow(/not schema-qualified/);
    expect(() => cast`CREATE CAST (int AS text) WITH INOUT; COMMENT ON CAST (int AS bigint) IS 'x'`).toThrow(/another cast/);
    expect(() => collation`CREATE TABLE app.t (a int)`).toThrow(SqlTemplateError);
  });
});

// ── Classifying and making changes ─────────────────────────────────────

const live = (type: string, statement: string, extra: Partial<LivePgObject> = {}) => pgSchemaFromLive([{ type, statement, name: "", oid: "1", ...extra } as LivePgObject], "public");
const declared = (type: string, ddl: string): PgSchemaObject[] => keyedByQualifiedName([{ key: "x", canonical: { ...diffObject(type, ddl, "public"), exportName: "x" } }]);
const rules = (type: string, before: string, after: string, extra: Partial<LivePgObject> = {}) =>
  diffPgSchemas(live(type, before, extra), declared(type, after)).changes.map((c) => [c.field, c.rule]);

const AGG = "Postgres::Aggregate";
const AGG1 = "CREATE AGGREGATE app.total(integer) (SFUNC = app.add2, STYPE = integer, INITCOND = '0')";

function steps(type: string, liveDdl: string, declaredDdl: string, extra: Partial<LivePgObject> = {}): string[] {
  const [obj] = declaredObjects(JSON.stringify({ dialect: "postgres", objects: [{ export: "x", type, ddl: declaredDdl, dependsOn: [] }] }));
  const after = keyedByQualifiedName([{ key: "x", canonical: obj!.canonical }]);
  const before = live(type, liveDdl, extra);
  const m = matchPgObjects(before, after).find((x) => x.kind === "matched")!;
  return alterSteps(obj!, m.before!.canonical, diffPgSchemas(before, after).changes, { major: 18 }).steps.map((s) => s.sql);
}

describe("the classifier and the statements", () => {
  test("the server's printing is the declaration's", () => {
    expect(rules(AGG, AGG1, "CREATE AGGREGATE app.total(int) (sfunc = app.add2, stype = int4, initcond = 0, parallel = unsafe)")).toEqual([]);
    expect(rules("Postgres::CompositeType", "CREATE TYPE app.pair AS (\n    a integer,\n    b text COLLATE \"C\"\n)", "CREATE TYPE app.pair AS (a int, b text COLLATE pg_catalog.\"C\")")).toEqual([]);
    expect(rules("Postgres::Cast", "CREATE CAST (app.pair AS text) WITH FUNCTION app.f(app.pair)", "CREATE CAST (app.pair AS text) WITH FUNCTION app.f")).toEqual([]);
  });

  test("an aggregate's options are replaced in place; its state type is a drop and a create, refused while something depends on it", () => {
    expect(rules(AGG, AGG1, AGG1.replace("'0'", "'1'"))).toEqual([["definition", "SQLPG302"]]);
    expect(steps(AGG, AGG1, AGG1.replace("'0'", "'1'"))).toEqual([AGG1.replace("CREATE ", "CREATE OR REPLACE ").replace("'0'", "'1'")]);
    expect(rules(AGG, AGG1, AGG1.replace("STYPE = integer", "STYPE = bigint"))).toEqual([["definition", "SQLPG300"]]);
    expect(rules(AGG, AGG1, AGG1.replace("STYPE = integer", "STYPE = bigint"), { dependents: ["view app.v"] })).toEqual([["definition", "SQLPG301"]]);
    const recreate = steps(AGG, AGG1, AGG1.replace("STYPE = integer", "STYPE = bigint"));
    expect(recreate[0]).toBe("DROP AGGREGATE app.total(integer)");
    expect(recreate[2]).toMatch(/^COMMENT ON AGGREGATE app\.total\(integer\) IS /);
  });

  test("a cast, an event trigger, a collation and a type are dropped and created", () => {
    const C1 = "CREATE CAST (app.pair AS text) WITH INOUT";
    expect(steps("Postgres::Cast", C1, `${C1} AS IMPLICIT`).slice(0, 2)).toEqual(["DROP CAST (app.pair AS text)", `${C1} AS IMPLICIT`]);
    const E1 = "CREATE EVENT TRIGGER e ON ddl_command_end EXECUTE FUNCTION app.f()";
    expect(steps("Postgres::EventTrigger", E1, E1.replace("ddl_command_end", "sql_drop"))[0]).toBe("DROP EVENT TRIGGER e");
    expect(rules("Postgres::Collation", "CREATE COLLATION app.c (LOCALE = 'C')", "CREATE COLLATION app.c (LOCALE = 'POSIX')", { dependents: ["column nick of table app.people"] })).toEqual([["lcCollate, lcCtype", "SQLPG301"]]);
    expect(rules("Postgres::RangeType", "CREATE TYPE app.r AS RANGE (SUBTYPE = integer)", "CREATE TYPE app.r AS RANGE (SUBTYPE = bigint)")).toEqual([["subtype", "SQLPG300"]]);
    expect(dropStatement("cast", undefined, "(a AS b)").sql).toBe("DROP CAST (a AS b)");
    expect(dropStatement("composite", "app", "pair").sql).toBe("DROP TYPE app.pair");
  });

  test("a comment changes in place", () => {
    expect(steps("Postgres::Collation", "CREATE COLLATION app.c (LOCALE = 'C')", "CREATE COLLATION app.c (LOCALE = 'C'); COMMENT ON COLLATION app.c IS 'c'")).toEqual([expect.stringMatching(/^COMMENT ON COLLATION app\.c IS 'c/)]);
  });
});

describe("importing", () => {
  test("each kind is written with its tag, its references interpolated", () => {
    const content = new PostgresGenerator().generate(
      objectsToIR([
        { type: "Postgres::CompositeType", schema: "app", name: "pair", ddl: "CREATE TYPE app.pair AS (a integer)" },
        { type: "Postgres::Function", schema: "app", name: "pair_text", ddl: "CREATE OR REPLACE FUNCTION app.pair_text(p app.pair)\n RETURNS text\n LANGUAGE sql\nAS $function$ SELECT '' $function$" },
        { type: "Postgres::Cast", name: "(app.pair AS text)", ddl: "CREATE CAST (app.pair AS text) WITH FUNCTION app.pair_text(app.pair)" },
        { type: "Postgres::Aggregate", schema: "app", name: "n", ddl: "CREATE AGGREGATE app.n(*) (SFUNC = int8inc, STYPE = bigint)" },
      ]),
    )[0]!.content;
    expect(content).toContain('import { aggregate, cast, func, type } from "@intentius/chant-lexicon-sql/postgres";');
    expect(content).toContain("CREATE CAST (${pair} AS text) WITH FUNCTION ${pairText}(${pair})");
    expect(content).toContain("export const n = aggregate`");
  });
});
