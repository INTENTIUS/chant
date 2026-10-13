/**
 * Row-level security, roles, grants and default privileges (#3681): what the
 * tags parse and refuse, how the declarations add up to access, and how a
 * change is classified and made.
 */

import { describe, expect, test } from "vitest";
import { func, grant, policy, role, schema, table } from "../entities";
import { diffObject, keyedByQualifiedName, pgSchemaFromBuildOutput, pgSchemaFromLive, type PgSchemaObject } from "../plan/schema";
import { diffPgSchemas, matchPgObjects } from "../plan/diff";
import { accessScoped } from "../plan/commands";
import { alterSteps } from "../apply/statements";
import { declaredObjects } from "../apply/apply";
import type { LivePgObject } from "../live/catalog";
import { declaredAccess, diffAccess } from "./acl";

const app = schema`CREATE SCHEMA app`;
const reader = role`CREATE ROLE app_reader NOLOGIN`;
const orders = table`
  CREATE TABLE ${app}.orders (id bigint PRIMARY KEY, tenant text NOT NULL, note text);
  ALTER TABLE ${app}.orders ENABLE ROW LEVEL SECURITY;
  ALTER TABLE ${app}.orders FORCE ROW LEVEL SECURITY`;

describe("a grant on an interpolated routine (#3707)", () => {
  const f = func`CREATE FUNCTION ${app}.total(n int, OUT t bigint) LANGUAGE sql AS 'select 1'`;
  const buildOf = (objects: Array<{ export: string; entity: { entityType: string; props: unknown } }>) =>
    JSON.stringify({
      dialect: "postgres",
      postgresMajor: 18,
      objects: objects.map((o) => ({ export: o.export, type: o.entity.entityType, ddl: (o.entity.props as { ddl: string }).ddl })),
    });

  test("its statement names the routine with its parameter types", () => {
    expect(grant`GRANT EXECUTE ON FUNCTION ${f} TO ${reader}`.props).toMatchObject({ ddl: "GRANT EXECUTE ON FUNCTION app.total(int) TO app_reader", objectNames: ["app.total(int)"] });
    // Types written after the reference are kept, not doubled.
    expect((grant`GRANT EXECUTE ON FUNCTION ${f}(int) TO ${reader}`.props as { ddl: string }).ddl).toBe("GRANT EXECUTE ON FUNCTION app.total(int) TO app_reader");
  });

  test("against a build from before the grant, it plans as one naming the signature does", () => {
    const before = pgSchemaFromBuildOutput(buildOf([{ export: "app", entity: app }, { export: "total", entity: f }]));
    const plan = (g: { entityType: string; props: unknown }) =>
      diffPgSchemas(before, pgSchemaFromBuildOutput(buildOf([{ export: "app", entity: app }, { export: "total", entity: f }, { export: "run", entity: g }])), { major: 18 }).changes.map((c) => [c.object, c.rule, c.after]);
    const interpolated = plan(grant`GRANT EXECUTE ON FUNCTION ${f} TO ${reader}`);
    expect(interpolated).toEqual(plan(grant`GRANT EXECUTE ON FUNCTION app.total(int) TO app_reader`));
    expect(interpolated.map(([, rule]) => rule)).toContain("SQLPG296");
  });
});

describe("the tags", () => {
  test("a table's row-level security, a policy, a role", () => {
    expect(orders.props).toMatchObject({ rowSecurity: true, forceRowSecurity: true });
    const p = policy`CREATE POLICY tenant_rows ON ${orders} AS RESTRICTIVE FOR SELECT TO ${reader}, PUBLIC USING (${orders.columns.tenant} = current_setting('app.tenant'))`;
    expect(p.entityType).toBe("Postgres::Policy");
    expect(p.props).toMatchObject({ schema: "app", name: "tenant_rows", tableName: "app.orders", permissive: false, command: "select", roles: ["app_reader", "public"], using: "tenant = current_setting('app.tenant')" });
    expect(p.dependsOn).toEqual(expect.arrayContaining([orders, reader]));
    expect(reader.props).toMatchObject({ name: "app_reader", options: ["nologin"] });
  });

  test("grants on a schema, a table's columns and a routine, a revoke, default privileges", () => {
    const f = func`CREATE FUNCTION ${app}.total(n int) RETURNS bigint LANGUAGE sql AS 'select 1'`;
    expect(grant`GRANT USAGE ON SCHEMA ${app} TO ${reader}`.props).toMatchObject({ action: "grant", on: "schema", objectNames: ["app"], grantees: ["app_reader"] });
    expect(grant`GRANT SELECT, UPDATE (note) ON ${orders} TO writer WITH GRANT OPTION`.props).toMatchObject({
      on: "table",
      privileges: [{ privilege: "select" }, { privilege: "update", columns: ["note"] }],
      withGrantOption: true,
    });
    expect(grant`REVOKE EXECUTE ON FUNCTION ${f} FROM PUBLIC`.props).toMatchObject({ action: "revoke", objectNames: ["app.total(int)"], grantees: ["public"] });
    const d = grant`ALTER DEFAULT PRIVILEGES IN SCHEMA ${app} GRANT SELECT ON TABLES TO ${reader}`;
    expect(d.entityType).toBe("Postgres::DefaultPrivileges");
    expect(d.props).toMatchObject({ inSchemas: ["app"], on: "tables", privileges: ["select"] });
  });

  test("secrets, memberships, ALL ... IN SCHEMA and an unnamed overload are refused", () => {
    expect(() => role`CREATE ROLE r LOGIN PASSWORD 'x'`).toThrow(/environment's secret/);
    expect(() => role`CREATE ROLE r IN ROLE admins`).toThrow(/environment's/);
    expect(() => grant`GRANT admins TO r`).toThrow(/membership/);
    expect(() => grant`GRANT SELECT ON ALL TABLES IN SCHEMA app TO r`).toThrow(/ALTER DEFAULT PRIVILEGES/);
    expect(() => grant`GRANT EXECUTE ON FUNCTION app.f TO r`).toThrow(/parameter types/);
    expect(() => table`ALTER TABLE app.t ENABLE ROW LEVEL SECURITY`).toThrow(/after the table's CREATE TABLE/);
  });
});

// ── Access ─────────────────────────────────────────────────────────────

const decl = (type: string, ddl: string, key = ddl): PgSchemaObject => ({ key, canonical: { ...diffObject(type, ddl, "public"), exportName: key } });
const T = (ddl: string) => decl("Postgres::Table", ddl);
const F = (ddl: string) => decl("Postgres::Function", ddl);
const G = (ddl: string) => decl("Postgres::Grant", ddl);
const D = (ddl: string) => decl("Postgres::DefaultPrivileges", ddl);

const entries = (objects: PgSchemaObject[]) =>
  Object.fromEntries([...declaredAccess(objects, { major: 18 }).state].map(([k, e]) => [k, [...e.privileges].map(([p, g]) => `${p}${g ? "*" : ""}`).sort().join(",")]));

describe("the access declarations add up to", () => {
  test("a routine's EXECUTE to PUBLIC unless revoked; grants added, revokes taken away, in order", () => {
    expect(entries([F("CREATE FUNCTION app.f() RETURNS int LANGUAGE sql AS 'select 1'")])).toEqual({ "routine app.f() TO PUBLIC": "execute" });
    expect(
      entries([
        F("CREATE FUNCTION app.f() RETURNS int LANGUAGE sql AS 'select 1'"),
        T("CREATE TABLE app.t (a int, b int)"),
        G("REVOKE EXECUTE ON FUNCTION app.f() FROM PUBLIC"),
        G("GRANT ALL ON app.t TO r WITH GRANT OPTION"),
        G("REVOKE GRANT OPTION FOR DELETE ON app.t FROM r"),
        G("REVOKE TRUNCATE, MAINTAIN ON app.t FROM r"),
        G("GRANT SELECT (b) ON app.t TO s"),
      ]),
    ).toEqual({ "relation app.t TO r": "delete,insert*,references*,select*,trigger*,update*", "relation app.t (b) TO s": "select" });
  });

  test("default privileges are compared themselves, and given to the objects chant creates", () => {
    expect(
      entries([
        T("CREATE TABLE app.t (a int)"),
        D("ALTER DEFAULT PRIVILEGES IN SCHEMA app GRANT SELECT ON TABLES TO r"),
        D("ALTER DEFAULT PRIVILEGES REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC"),
        F("CREATE FUNCTION app.f() RETURNS int LANGUAGE sql AS 'select 1'"),
      ]),
    ).toEqual({ "default privileges in app on tables TO r": "select", "relation app.t TO r": "select" });
  });

  test("a change is a GRANT, a REVOKE, or ALTER DEFAULT PRIVILEGES", () => {
    const before = declaredAccess([T("CREATE TABLE app.t (a int)"), G("GRANT SELECT, INSERT ON app.t TO r")], { major: 18 });
    const after = declaredAccess([T("CREATE TABLE app.t (a int)"), G("GRANT SELECT ON app.t TO r WITH GRANT OPTION"), G("GRANT USAGE ON SCHEMA app TO r"), D("ALTER DEFAULT PRIVILEGES FOR ROLE owner IN SCHEMA app GRANT SELECT ON TABLES TO r")], { major: 18 });
    expect(diffAccess(before.state, after.state).map((c) => [c.change.object, c.change.rule, c.sql])).toEqual([
      ["acl default privileges for owner in app on tables TO r", "SQLPG298", ["ALTER DEFAULT PRIVILEGES FOR ROLE owner IN SCHEMA app GRANT SELECT ON TABLES TO r"]],
      ["acl relation app.t TO r", "SQLPG296", ["REVOKE INSERT ON TABLE app.t FROM r", "GRANT SELECT ON TABLE app.t TO r WITH GRANT OPTION"]],
      ["acl schema app TO r", "SQLPG296", ["GRANT USAGE ON SCHEMA app TO r"]],
    ]);
  });

  test("between two builds, a new function's EXECUTE to PUBLIC is not a change", () => {
    const f = "CREATE FUNCTION app.f() RETURNS int LANGUAGE sql AS 'select 1'";
    expect(diffPgSchemas([], [F(f)]).changes.map((c) => c.rule)).toEqual(["SQLPG200"]);
    expect(diffPgSchemas([], [F(f), G("REVOKE EXECUTE ON FUNCTION app.f() FROM PUBLIC")]).changes.map((c) => [c.object, c.rule])).toEqual([
      [f, "SQLPG200"],
      ["acl routine app.f() TO PUBLIC", "SQLPG297"],
    ]);
  });

  test("a profile that does not manage access leaves out the access declarations and a table's row-level security", () => {
    const { kept, unmanaged } = accessScoped(keyedByQualifiedName([T("CREATE TABLE app.t (a int);\nALTER TABLE app.t ENABLE ROW LEVEL SECURITY"), G("GRANT SELECT ON app.t TO r")]), false);
    expect(unmanaged).toBe(2);
    expect(kept.map((o) => [o.canonical.kind, o.canonical.fields.rowSecurity])).toEqual([["table", undefined]]);
  });
});

// ── Policies, row-level security, roles ────────────────────────────────

const live = (type: string, statement: string) => pgSchemaFromLive([{ type, statement, name: "", oid: "1" } as LivePgObject], "public");
function steps(type: string, liveDdl: string, declaredDdl: string): string[] {
  const [obj] = declaredObjects(JSON.stringify({ dialect: "postgres", objects: [{ export: "x", type, ddl: declaredDdl, dependsOn: [] }] }));
  const after = keyedByQualifiedName([{ key: "x", canonical: obj!.canonical }]);
  const before = live(type, liveDdl);
  const m = matchPgObjects(before, after).find((x) => x.kind === "matched")!;
  return alterSteps(obj!, m.before!.canonical, diffPgSchemas(before, after).changes, { major: 18 }).steps.map((s) => s.sql);
}

describe("the classifier and the statements", () => {
  const P = "Postgres::Policy";
  test("a policy's roles and expressions are ALTER POLICY; its command is a drop and a create", () => {
    const p1 = "CREATE POLICY p ON app.t FOR SELECT TO r USING (a > 0)";
    expect(steps(P, p1, "CREATE POLICY p ON app.t FOR SELECT TO r, s USING (a > 1)")).toEqual(["ALTER POLICY p ON app.t TO r, s USING (a > 1)"]);
    expect(steps(P, p1, "CREATE POLICY p ON app.t FOR UPDATE TO r USING (a > 0)").slice(0, 2)).toEqual(["DROP POLICY p ON app.t", "CREATE POLICY p ON app.t FOR UPDATE TO r USING (a > 0)"]);
    expect(diffPgSchemas([], keyedByQualifiedName([decl(P, p1)])).changes.map((c) => c.rule)).toEqual(["SQLPG290"]);
    expect(diffPgSchemas(live(P, p1), []).changes.map((c) => c.rule)).toEqual(["SQLPG292"]);
  });

  test("row-level security toggled, and a role's attributes changed", () => {
    expect(steps("Postgres::Table", "CREATE TABLE app.t (a int)", "CREATE TABLE app.t (a int);\nALTER TABLE app.t ENABLE ROW LEVEL SECURITY")).toEqual(["ALTER TABLE app.t ENABLE ROW LEVEL SECURITY"]);
    expect(steps("Postgres::Role", "CREATE ROLE r", "CREATE ROLE r LOGIN NOINHERIT CONNECTION LIMIT 5")).toEqual(["ALTER ROLE r WITH LOGIN NOINHERIT CONNECTION LIMIT 5"]);
  });
});
