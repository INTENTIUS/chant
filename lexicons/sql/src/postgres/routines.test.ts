/**
 * Functions, procedures and triggers (#3680): what the tags parse and refuse,
 * how a change to each is classified and made, and how an import writes them.
 */

import { describe, expect, test } from "vitest";
import { func, procedure, schema, SqlTemplateError, table, trigger } from "./entities";
import { diffObject, keyedByQualifiedName, pgSchemaFromLive, type PgSchemaObject } from "./plan/schema";
import { diffPgSchemas, matchPgObjects } from "./plan/diff";
import { alterSteps, dropStatement } from "./apply/statements";
import { declaredObjects } from "./apply/apply";
import type { LivePgObject } from "./live/catalog";
import { objectsToIR } from "./import/ir";
import { PostgresGenerator } from "./import/generator";

const app = schema`CREATE SCHEMA app`;
const users = table`CREATE TABLE ${app}.users (id bigint PRIMARY KEY, email text, updated_at timestamptz)`;

describe("the tags", () => {
  test("a function: its signature, attributes and body as written; an interpolation in the body is a reference", () => {
    const count = func`
      CREATE FUNCTION ${app}.user_count(min_id int = 0, OUT n bigint)
      LANGUAGE sql STABLE STRICT PARALLEL SAFE SET search_path = ${app}
      AS $$ SELECT count(*) FROM ${users} WHERE ${users.columns.id} >= min_id $$;
      COMMENT ON FUNCTION ${app}.user_count(int) IS 'Users'`;
    expect(count.entityType).toBe("Postgres::Function");
    expect(count.sqlName).toBe("app.user_count");
    expect(count.props).toMatchObject({
      schema: "app",
      name: "user_count",
      args: [
        { mode: "in", name: "min_id", type: "int", default: "0" },
        { mode: "out", name: "n", type: "bigint" },
      ],
      language: "sql",
      volatility: "stable",
      strict: true,
      parallel: "safe",
      set: { search_path: "app" },
      body: " SELECT count(*) FROM app.users WHERE id >= min_id ",
      comment: "Users",
    });
    expect(count.dependsOn).toContain(users);
    expect(count.props.reads).toEqual([users]);
  });

  test("a procedure and a trigger", () => {
    const archive = procedure`CREATE PROCEDURE ${app}.archive(IN before bigint, INOUT n int DEFAULT NULL) LANGUAGE plpgsql AS 'BEGIN n := 0; END'`;
    expect(archive.props).toMatchObject({ args: [{ mode: "in", name: "before" }, { mode: "inout", name: "n", default: "NULL" }], body: "BEGIN n := 0; END" });
    const touch = func`CREATE FUNCTION ${app}.touch() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN NEW.updated_at := now(); RETURN NEW; END $$`;
    const t = trigger`CREATE TRIGGER users_touch BEFORE INSERT OR UPDATE OF email ON ${users} FOR EACH ROW WHEN (NEW.email IS NOT NULL) EXECUTE FUNCTION ${touch}('x', 1)`;
    expect(t.entityType).toBe("Postgres::Trigger");
    expect(t.props).toMatchObject({
      schema: "app",
      name: "users_touch",
      timing: "before",
      events: [{ event: "insert" }, { event: "update", columns: ["email"] }],
      tableName: "app.users",
      forEach: "row",
      when: "NEW.email IS NOT NULL",
      functionName: "app.touch",
      args: ["'x'", "1"],
    });
    expect(t.dependsOn).toEqual([users, touch]);
  });

  test("a SQL-standard body, SET FROM CURRENT and a qualified trigger name are refused", () => {
    expect(() => func`CREATE FUNCTION app.f(a int) RETURNS int LANGUAGE sql RETURN a + 1`).toThrow(/SQL-standard body/);
    expect(() => func`CREATE FUNCTION app.f() RETURNS int LANGUAGE sql BEGIN ATOMIC SELECT 1; END`).toThrow(/SQL-standard body/);
    expect(() => func`CREATE FUNCTION app.f() RETURNS int LANGUAGE sql SET search_path FROM CURRENT AS 'select 1'`).toThrow(/FROM CURRENT/);
    expect(() => procedure`CREATE PROCEDURE app.p() LANGUAGE sql STABLE AS 'select 1'`).toThrow(/not an attribute of a procedure/);
    expect(() => trigger`CREATE TRIGGER app.t BEFORE INSERT ON app.users EXECUTE FUNCTION app.f()`).toThrow(/not schema-qualified/);
    expect(() => func`CREATE TABLE app.t (a int)`).toThrow(SqlTemplateError);
  });
});

// ── Classifying and making changes ─────────────────────────────────────

const F = "Postgres::Function";
const TR = "Postgres::Trigger";
const live = (type: string, statement: string, extra: Partial<LivePgObject> = {}) => pgSchemaFromLive([{ type, statement, name: "", oid: "1", ...extra } as LivePgObject], "public");
const declared = (type: string, ddl: string): PgSchemaObject[] => keyedByQualifiedName([{ key: "x", canonical: { ...diffObject(type, ddl, "public"), exportName: "x" } }]);
const rules = (type: string, before: string, after: string, extra: Partial<LivePgObject> = {}) =>
  diffPgSchemas(live(type, before, extra), declared(type, after)).changes.map((c) => [c.field, c.rule]);

const FN = (body: string, returns = "integer", args = "a integer") => `CREATE FUNCTION app.f(${args}) RETURNS ${returns} LANGUAGE sql AS $$ ${body} $$`;
const SERVER_FN = "CREATE OR REPLACE FUNCTION app.f(a integer)\n RETURNS integer\n LANGUAGE sql\nAS $function$ select a $function$\n";

describe("the classifier", () => {
  test("the server's printing of a function is the declaration's", () => {
    expect(rules(F, SERVER_FN, FN("select a", "int", "a int"))).toEqual([]);
  });

  test("a new body or attribute is CREATE OR REPLACE; a new result is drop and create, or expand and contract when something depends on it", () => {
    expect(rules(F, SERVER_FN, FN("select a + 1"))).toEqual([["body", "SQLPG280"]]);
    expect(rules(F, SERVER_FN, FN("select a", "bigint"))).toEqual([["returns", "SQLPG281"]]);
    expect(rules(F, SERVER_FN, FN("select a", "integer", "b integer"))).toEqual([["args", "SQLPG281"]]);
    expect(rules(F, SERVER_FN, FN("select a", "bigint"), { dependents: ["view app.v"] })).toEqual([["returns", "SQLPG282"]]);
  });

  test("a trigger: created on an existing table under SHARE ROW EXCLUSIVE, changed in place, dropped", () => {
    const T1 = "CREATE TRIGGER t BEFORE UPDATE ON app.users FOR EACH ROW EXECUTE FUNCTION app.touch()";
    const T2 = "CREATE TRIGGER t BEFORE INSERT OR UPDATE ON app.users FOR EACH ROW EXECUTE FUNCTION app.touch()";
    expect(diffPgSchemas([], declared(TR, T1)).changes.map((c) => c.rule)).toEqual(["SQLPG283"]);
    expect(rules(TR, T1, T2)).toEqual([["events", "SQLPG284"]]);
    expect(diffPgSchemas(live(TR, T1), []).changes.map((c) => [c.rule, c.class])).toEqual([["SQLPG285", "drop"]]);
  });
});

function steps(type: string, liveDdl: string, declaredDdl: string): string[] {
  const [obj] = declaredObjects(JSON.stringify({ dialect: "postgres", objects: [{ export: "x", type, ddl: declaredDdl, dependsOn: [] }] }));
  const after = keyedByQualifiedName([{ key: "x", canonical: obj!.canonical }]);
  const before = live(type, liveDdl);
  const m = matchPgObjects(before, after).find((x) => x.kind === "matched")!;
  return alterSteps(obj!, m.before!.canonical, diffPgSchemas(before, after).changes, { major: 18 }).steps.map((s) => s.sql);
}

describe("the statements", () => {
  test("OR REPLACE, or a drop and a create named by the parameter types", () => {
    expect(steps(F, SERVER_FN, FN("select a + 1"))).toEqual(["CREATE OR REPLACE FUNCTION app.f(a integer) RETURNS integer LANGUAGE sql AS $$ select a + 1 $$"]);
    const recreate = steps(F, SERVER_FN, FN("select a", "bigint"));
    expect(recreate[0]).toBe("DROP FUNCTION app.f(integer)");
    expect(recreate[1]).toBe("CREATE FUNCTION app.f(a integer) RETURNS bigint LANGUAGE sql AS $$ select a $$");
    expect(recreate[2]).toMatch(/^COMMENT ON FUNCTION app\.f\(integer\) IS /);
    expect(dropStatement("procedure", "app", "p", "(integer,text)").sql).toBe("DROP PROCEDURE app.p(integer,text)");
  });

  test("a trigger is replaced in place; a constraint trigger is dropped and created", () => {
    const T1 = "CREATE TRIGGER t BEFORE UPDATE ON app.users FOR EACH ROW EXECUTE FUNCTION app.touch()";
    expect(steps(TR, T1, T1.replace("UPDATE", "INSERT"))).toEqual(["CREATE OR REPLACE TRIGGER t BEFORE INSERT ON app.users FOR EACH ROW EXECUTE FUNCTION app.touch()"]);
    const C1 = "CREATE CONSTRAINT TRIGGER t AFTER UPDATE ON app.users DEFERRABLE FOR EACH ROW EXECUTE FUNCTION app.touch()";
    expect(steps(TR, C1, C1.replace("UPDATE", "INSERT")).slice(0, 2)).toEqual(["DROP TRIGGER t ON app.users", C1.replace("UPDATE", "INSERT")]);
    expect(dropStatement("trigger", "app", "t", " ON app.users").sql).toBe("DROP TRIGGER t ON app.users");
  });
});

describe("importing", () => {
  test("functions and triggers are written as func and trigger declarations, their references interpolated", () => {
    const content = new PostgresGenerator().generate(
      objectsToIR([
        { type: "Postgres::Table", schema: "app", name: "users", ddl: "CREATE TABLE app.users (\n    id bigint\n)" },
        { type: "Postgres::Function", schema: "app", name: "touch", ddl: "CREATE OR REPLACE FUNCTION app.touch()\n RETURNS trigger\n LANGUAGE plpgsql\nAS $function$ BEGIN RETURN NEW; END $function$" },
        { type: "Postgres::Trigger", schema: "app", name: "users_touch", ddl: "CREATE TRIGGER users_touch BEFORE UPDATE ON app.users FOR EACH ROW EXECUTE FUNCTION app.touch()" },
      ]),
    )[0]!.content;
    expect(content).toContain('import { func, table, trigger } from "@intentius/chant-lexicon-sql/postgres";');
    expect(content).toContain("export const touch = func`");
    expect(content).toContain("ON ${users} FOR EACH ROW EXECUTE FUNCTION ${touch}()");
  });
});
