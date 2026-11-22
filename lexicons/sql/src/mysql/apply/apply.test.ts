import { describe, expect, test } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SerializerResult } from "@intentius/chant/serializer";
import { sqlSerializer } from "../../serializer";
import { database, table, view } from "../entities";
import { applyMysql, declaredObjects, MysqlApplyError, planAgainstClient, withTableComment, type MysqlDeclaredObject } from "./apply";
import { fakeMysqlServer, type FakeObject } from "../testing/fake-server";
import { SHOP_OBJECTS, SHOP_SOURCE } from "../testdata/shop";
import { mysqlApply } from "../../op/activities/mysql-apply";
import { canonicalObject } from "../canonical";
import { diffMysqlSchemas } from "../plan/diff";

const tag = (fn: (s: TemplateStringsArray) => unknown, sql: string) => fn(Object.assign([sql], { raw: [sql] }) as unknown as TemplateStringsArray);

/** The build output of `sources` (export name to statement), as `chant build` writes it. */
function buildJson(sources: Record<string, { kind: "database" | "table" | "view"; sql: string }>): string {
  const entities = new Map<string, unknown>();
  for (const [name, s] of Object.entries(sources)) entities.set(name, tag(s.kind === "database" ? database : s.kind === "table" ? table : view, s.sql));
  return (sqlSerializer.serialize(entities as never) as SerializerResult).primary;
}

const SHOP_BUILD = {
  shop: { kind: "database" as const, sql: SHOP_SOURCE.database },
  users: { kind: "table" as const, sql: SHOP_SOURCE.users },
  orders: { kind: "table" as const, sql: SHOP_SOURCE.orders },
  paidOrders: { kind: "view" as const, sql: SHOP_SOURCE.paidOrders },
};

const target = { endpoint: { url: "mysql://db:3306/shop" }, source: "sql.profiles.prod", defaultDatabase: "shop" };
const marker = { stack: "shop", env: "prod" };
const declared = (sources: Parameters<typeof buildJson>[0]): MysqlDeclaredObject[] => declaredObjects(buildJson(sources), "shop");

describe("the MySQL plan against a recorded schema (#5449)", () => {
  test("a server that holds what the build declares plans no change", async () => {
    const plan = await planAgainstClient(fakeMysqlServer({ objects: SHOP_OBJECTS }), target, declared(SHOP_BUILD));
    expect(plan.changes).toEqual([]);
    expect(plan.unreadable).toEqual([]);
  });

  test("each change is classed by the algorithm InnoDB uses for it, with the statement that makes it", async () => {
    const changed = {
      ...SHOP_BUILD,
      users: {
        kind: "table" as const,
        sql: SHOP_SOURCE.users
          .replace("name VARCHAR(100),", "name VARCHAR(200),\n    nickname VARCHAR(50),")
          .replace("DEFAULT TRUE", "DEFAULT FALSE")
          .replace("UNIQUE KEY users_email (email)", "UNIQUE KEY users_email (email),\n    KEY users_name (name)"),
      },
    };
    const plan = await planAgainstClient(fakeMysqlServer({ objects: SHOP_OBJECTS }), target, declared(changed));
    expect(plan.changes.map((c) => [c.field, c.rule, c.class])).toEqual([
      ["columns.name.type", "SQLMY204", "copy"],
      ["columns.nickname", "SQLMY201", "instant"],
      ["columns.active.default", "SQLMY205", "instant"],
      ["indexes.users_name", "SQLMY209", "inplace"],
    ]);
    expect(plan.statements.get("table shop.users")?.clauses).toEqual([
      "MODIFY COLUMN name VARCHAR(200)",
      "ADD COLUMN nickname VARCHAR(50)",
      "ALTER COLUMN active SET DEFAULT FALSE",
      "ADD INDEX users_name (name)",
    ]);
  });

  test("a dropped column is destructive, and a changed foreign key is dropped in a statement before it is added", () => {
    const live = canonicalObject(SHOP_OBJECTS[2]!.statement, "shop");
    const after = canonicalObject(SHOP_SOURCE.orders.replace("ON DELETE CASCADE", "ON DELETE RESTRICT").replace("status ENUM('new', 'paid', 'shipped') NOT NULL DEFAULT 'new',", ""), "shop");
    const diff = diffMysqlSchemas([{ key: "t", canonical: live }], [{ key: "t", canonical: after }]);
    expect(diff.changes.find((c) => c.field === "columns.status")).toMatchObject({ rule: "SQLMY203", destructive: true });
    expect(diff.changes.find((c) => c.field === "foreignKeys.orders_user")).toMatchObject({ rule: "SQLMY213", class: "copy" });
    expect(diff.statements.get("t")).toMatchObject({
      before: ["ALTER TABLE shop.orders DROP FOREIGN KEY orders_user"],
      clauses: ["DROP COLUMN status", "ADD CONSTRAINT orders_user FOREIGN KEY (user_id) REFERENCES shop.users (id) ON DELETE RESTRICT ON UPDATE RESTRICT"],
    });
  });

  test("a view whose query changes is replaced", async () => {
    const changed = { ...SHOP_BUILD, paidOrders: { kind: "view" as const, sql: SHOP_SOURCE.paidOrders.replace("'paid'", "'shipped'") } };
    const plan = await planAgainstClient(fakeMysqlServer({ objects: SHOP_OBJECTS }), target, declared(changed));
    expect(plan.changes.map((c) => [c.object, c.field, c.rule])).toEqual([["view shop.paid_orders", "query", "SQLMY222"]]);
  });

  test("MariaDB and a MySQL major with no pin are refused before anything is read", async () => {
    await expect(planAgainstClient(fakeMysqlServer({ version: "10.11.6-MariaDB", objects: SHOP_OBJECTS }), target, declared(SHOP_BUILD))).rejects.toThrow(/the server is MariaDB \(10\.11\.6-MariaDB\)/);
    await expect(planAgainstClient(fakeMysqlServer({ version: "5.7.44", objects: SHOP_OBJECTS }), target, declared(SHOP_BUILD))).rejects.toThrow(/reports version 5\.7\.44/);
    await expect(planAgainstClient(fakeMysqlServer({ version: "8.0.32", aurora: "3.05.2", objects: SHOP_OBJECTS }), target, declared(SHOP_BUILD))).resolves.toMatchObject({ changes: [] });
  });
});

describe("the MySQL applier (#5449)", () => {
  test("creates what the server lacks, the table with the ownership marker on its comment, in dependency order", async () => {
    const server = fakeMysqlServer({ objects: [] });
    const outcome = await applyMysql(server, target, declared(SHOP_BUILD), { marker });
    expect(outcome.applied.map((a) => [a.name, a.action])).toEqual([
      ["database shop", "created"],
      ["table shop.users", "created"],
      ["table shop.orders", "created"],
      ["view shop.paid_orders", "created"],
    ]);
    expect(server.sent[0]).toBe(SHOP_SOURCE.database);
    expect(server.sent[1]).toMatch(/COMMENT = 'people who buy \[chant managed-by=chant stack=shop env=prod\]'$/);
    expect(server.sent[2]).toMatch(/\) COMMENT = '\[chant managed-by=chant stack=shop env=prod\]'$/);
  });

  test("leaves a server that holds the build unchanged, and stamps a table that lacks the marker", async () => {
    const unmarked: FakeObject[] = SHOP_OBJECTS.map((o) => (o.name === "orders" ? { ...o, comment: "", statement: o.statement.replace(/ COMMENT='[^']*'$/, "") } : o));
    const server = fakeMysqlServer({ objects: unmarked });
    const outcome = await applyMysql(server, target, declared(SHOP_BUILD), { marker });
    expect(outcome.applied.map((a) => [a.name, a.action])).toEqual([
      ["database shop", "unchanged"],
      ["table shop.users", "unchanged"],
      ["table shop.orders", "updated"],
      ["view shop.paid_orders", "unchanged"],
    ]);
    expect(server.sent).toEqual(["ALTER TABLE shop.orders COMMENT = '[chant managed-by=chant stack=shop env=prod]'"]);
  });

  test("a column drop waits for prune, and prune drops only this project's tables", async () => {
    const withExtra: FakeObject[] = [
      ...SHOP_OBJECTS,
      { kind: "table", database: "shop", name: "old_carts", statement: "CREATE TABLE `old_carts` (\n  `id` int NOT NULL\n) ENGINE=InnoDB COMMENT='[chant managed-by=chant stack=shop env=prod]'", comment: "[chant managed-by=chant stack=shop env=prod]" },
      { kind: "table", database: "shop", name: "theirs", statement: "CREATE TABLE `theirs` (\n  `id` int NOT NULL\n) ENGINE=InnoDB", comment: "" },
    ];
    const build = { ...SHOP_BUILD, users: { kind: "table" as const, sql: SHOP_SOURCE.users.replace("name VARCHAR(100),", "") } };
    const without = await applyMysql(fakeMysqlServer({ objects: withExtra }), target, declared(build), { marker });
    expect(without.notAttempted).toEqual([{ kind: "MySQL::Table", name: "table shop.users", reason: "filtered", detail: "drops column name, which destroys data; apply with prune to drop" }]);
    expect(without.pruned).toEqual([]);
    const server = fakeMysqlServer({ objects: withExtra });
    const pruned = await applyMysql(server, target, declared(build), { marker, prune: true });
    expect(pruned.applied.find((a) => a.name === "table shop.users")?.statements).toEqual(["ALTER TABLE shop.users DROP COLUMN name"]);
    expect(pruned.pruned.map((p) => p.statement)).toEqual(["DROP TABLE shop.old_carts"]);
  });

  test("a statement the server refuses fails its object, the rest go on, and the apply throws with the outcome", async () => {
    const server = fakeMysqlServer({ objects: [], fail: [{ match: /^CREATE TABLE shop\.users/, message: "Table 'users' already exists", code: "ER_TABLE_EXISTS_ERROR" }] });
    const err = await applyMysql(server, target, declared(SHOP_BUILD), { marker }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MysqlApplyError);
    const outcome = (err as MysqlApplyError).outcome;
    expect(outcome.failed.map((f) => f.name)).toEqual(["table shop.users"]);
    expect(outcome.notAttempted.map((n) => [n.name, n.reason])).toEqual([["table shop.orders", "dependency-failed"]]);
    expect(outcome.applied.map((a) => a.name)).toEqual(["database shop", "view shop.paid_orders"]);
  });

  test("mysqlApply binds the profile and connects through the injected client; an unbound environment applies nothing", async () => {
    const dir = mkdtempSync(join(tmpdir(), "chant-mysql-apply-"));
    const buildPath = join(dir, "schema.json");
    writeFileSync(buildPath, buildJson(SHOP_BUILD));
    const config = { sql: { profiles: { prod: { url: "mysql://db:3306/shop", password: { env: "MYSQL_PW" } } } }, ownership: { stack: "shop", env: "prod" } };
    const server = fakeMysqlServer({ objects: SHOP_OBJECTS });
    const outcome = await mysqlApply({ buildPath, environment: "prod" }, undefined, { config, env: { MYSQL_PW: "x" }, connect: async () => server, log: () => undefined });
    expect(outcome.applied.every((a) => a.action === "unchanged")).toBe(true);
    expect(server.ended).toBe(true);
    const unbound = await mysqlApply({ buildPath, environment: "prod" }, undefined, { config, env: {}, connect: async () => server, log: () => undefined });
    expect(unbound.notAttempted[0]).toMatchObject({ reason: "no-credentials" });
  });

  test("a table's comment is set in place of the declared one", () => {
    expect(withTableComment("CREATE TABLE t (a INT) ENGINE = InnoDB COMMENT = 'x' ROW_FORMAT = DYNAMIC", "y")).toBe("CREATE TABLE t (a INT) ENGINE = InnoDB COMMENT = 'y' ROW_FORMAT = DYNAMIC");
    expect(withTableComment("CREATE TABLE t (a INT)", "it's")).toBe("CREATE TABLE t (a INT) COMMENT = 'it''s'");
  });
});
