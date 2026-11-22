import { describe, expect, test } from "vitest";
import { database, isMysqlObject, literal, table, view, MYSQL_ENTITY_TYPES } from "./entities";
import { sqlSerializer } from "../serializer";
import type { SerializerResult } from "@intentius/chant/serializer";
import { table as chTable } from "../clickhouse/entities";

describe("the MySQL tags (#5449)", () => {
  const shop = database`CREATE DATABASE shop DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci`;
  const users = table`
    CREATE TABLE ${shop}.users (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
      email VARCHAR(255) NOT NULL COMMENT 'login',
      status ENUM('active', 'gone') NOT NULL DEFAULT ${literal("active")},
      UNIQUE KEY users_email (email),
      KEY users_status USING BTREE (status) INVISIBLE,
      CHECK (char_length(email) > 3)
    ) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COMMENT = 'accounts' STATS_PERSISTENT = 1`;
  const orders = table`
    CREATE TABLE ${shop}.orders (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      user_id BIGINT UNSIGNED NOT NULL,
      PRIMARY KEY (id),
      CONSTRAINT orders_user FOREIGN KEY (user_id) REFERENCES ${users} (${users.columns.id}) ON DELETE CASCADE
    )`;

  test("a database's options", () => {
    expect(shop.entityType).toBe(MYSQL_ENTITY_TYPES.database);
    expect(shop.sqlName).toBe("shop");
    expect(shop.props).toMatchObject({ name: "shop", charset: "utf8mb4", collate: "utf8mb4_0900_ai_ci" });
  });

  test("a table's columns, keys, checks and options, and its database from the interpolated one", () => {
    expect(users.sqlName).toBe("shop.users");
    expect(users.props.database).toBe("shop");
    expect(users.props.columns.map((c) => [c.name, c.type, c.nullable])).toEqual([
      ["id", "BIGINT UNSIGNED", false],
      ["email", "VARCHAR(255)", false],
      ["status", "ENUM('active', 'gone')", false],
    ]);
    expect(users.props.columns[2]!.default).toBe("'active'");
    expect(users.props.columns[1]!.comment).toBe("login");
    expect(users.props.primaryKey).toEqual({ columns: [{ column: "id" }] });
    expect(users.props.indexes).toEqual([
      { kind: "unique", name: "users_email", columns: [{ column: "email" }] },
      { kind: "index", name: "users_status", columns: [{ column: "status" }], using: "BTREE", invisible: true },
    ]);
    expect(users.props.checks).toEqual([{ expr: "char_length(email) > 3" }]);
    expect(users.props).toMatchObject({ engine: "InnoDB", charset: "utf8mb4", comment: "accounts", options: { STATS_PERSISTENT: "1" } });
    expect(Object.keys(users.columns)).toEqual(["id", "email", "status"]);
  });

  test("a foreign key references the declared table and column, and renders their names", () => {
    expect(orders.props.foreignKeys).toEqual([{ name: "orders_user", columns: ["user_id"], references: users, refColumns: ["id"], onDelete: "CASCADE" }]);
    expect(orders.props.ddl).toContain("REFERENCES shop.users (id) ON DELETE CASCADE");
    expect(orders.dependsOn).toContain(users);
  });

  test("a view's reads and lineage", () => {
    const active = view`CREATE VIEW ${shop}.active_users AS SELECT ${users.columns.id}, ${users.columns.email} AS login FROM ${users} WHERE status = 'active'`;
    expect(active.props.reads).toEqual([users]);
    expect(active.props.lineage.map((e) => e.output)).toEqual(["id", "login"]);
    expect(Object.keys(active.columns)).toEqual(["id", "login"]);
  });

  test("a view's check option is read off its end, not its query", () => {
    const v = view`CREATE ALGORITHM = MERGE SQL SECURITY INVOKER VIEW v AS WITH x AS (SELECT 1 AS a) SELECT a FROM x WITH LOCAL CHECK OPTION`;
    expect(v.props).toMatchObject({ algorithm: "MERGE", security: "INVOKER", checkOption: "LOCAL", select: "WITH x AS (SELECT 1 AS a) SELECT a FROM x" });
  });

  test("a backquoted name and a double-quoted string are MySQL's", () => {
    const t = table`CREATE TABLE \`order\` (\`key\` VARCHAR(10) DEFAULT "x")`;
    expect(t.sqlName).toBe("`order`");
    expect(t.props.columns[0]).toMatchObject({ name: "key", default: '"x"' });
  });

  test("a CREATE in the wrong tag, or another dialect's entity, is refused", () => {
    expect(() => table`CREATE VIEW v AS SELECT 1`).toThrow(/holds a CREATE VIEW; use the view tag/);
    expect(() => table`CREATE INDEX i ON t (a)`).toThrow(/declare the index inside its table's CREATE TABLE/);
    const ch = chTable`CREATE TABLE e (a UInt8) ENGINE = Memory`;
    expect(isMysqlObject(ch)).toBe(false);
    expect(() => view`CREATE VIEW v AS SELECT * FROM ${ch}`).toThrow(/has no SQL form|interpolation/);
  });

  test.each([
    ["CREATE TEMPORARY TABLE t (a INT)", /temporary table lives in one session/],
    ["CREATE TABLE t LIKE u", /LIKE copies another table's definition/],
    ["CREATE TABLE t AS SELECT 1 AS a", /SELECT fills the table from a query/],
    ["CREATE TABLE t (a INT) PARTITION BY HASH (a)", /chant does not plan partition changes/],
    ["CREATE TABLE t (a INT REFERENCES u (id))", /parses a column's own REFERENCES and creates no foreign key/],
    ["CREATE OR REPLACE TABLE t (a INT)", /MariaDB's/],
    ["CREATE TABLE t (a INT AS (1) PERSISTENT)", /PERSISTENT generated column is MariaDB's/],
    ["CREATE TABLE t (a INT) WITH SYSTEM VERSIONING", /MariaDB's/],
    ["CREATE TABLE t (a SERIAL)", /SERIAL is BIGINT UNSIGNED NOT NULL AUTO_INCREMENT UNIQUE/],
    ["CREATE TABLE t (a UUID)", /UUID as a column type is MariaDB's/],
    ["CREATE TABLE t (a NUMBER)", /NUMBER is not a MySQL 8.0 column type/],
  ])("refuses %s", (sql, message) => {
    expect(() => table(Object.assign([sql], { raw: [sql] }) as unknown as TemplateStringsArray)).toThrow(message);
  });

  test("refuses a view IF NOT EXISTS as MariaDB's, and a CREATE TRIGGER as no kind chant declares", () => {
    expect(() => view`CREATE VIEW IF NOT EXISTS v AS SELECT 1`).toThrow(/MariaDB's/);
    expect(() => view`CREATE DEFINER = app TRIGGER t BEFORE INSERT ON x FOR EACH ROW SET NEW.a = 1`).toThrow(/a CREATE TRIGGER is not one of them/);
  });

  test("a build holds the MySQL dialect, its objects in creation order, and mysql.sql beside it", () => {
    const out = sqlSerializer.serialize(new Map<string, unknown>([["orders", orders], ["users", users], ["shop", shop]]) as never) as SerializerResult;
    const doc = JSON.parse(out.primary) as { dialect: string; applyOrder: string[]; objects: Array<{ export: string; type: string; foreignKeys?: Array<{ references: string }> }> };
    expect(doc.dialect).toBe("mysql");
    expect(doc.applyOrder).toEqual(["shop", "users", "orders"]);
    expect(doc.objects[2]!.foreignKeys![0]!.references).toBe("users");
    expect(out.files?.["mysql.sql"]).toContain("CREATE DATABASE shop");
  });

  test("one build holds one dialect", () => {
    const ch = chTable`CREATE TABLE e (a UInt8) ENGINE = Memory`;
    expect(() => sqlSerializer.serialize(new Map<string, unknown>([["e", ch], ["users", users]]) as never)).toThrow(/ClickHouse \(e\) and MySQL \(users\)/);
  });
});
