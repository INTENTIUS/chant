import { describe, expect, test } from "vitest";
import { exportMysqlResources } from "./live-export";
import { MysqlGenerator, stripServerDefaults } from "./generator";
import { fakeMysqlServer } from "../testing/fake-server";
import { SHOP_OBJECTS, SHOP_SOURCE, ORDERS_TABLE } from "../testdata/shop";
import { canonicalObject, objectKey } from "../canonical";
import { diffMysqlSchemas } from "../plan/diff";
import { SqlFileParser } from "../../import-parser";
import { readSqlFile, sqlFileEntities } from "../../sql-files";
import { UndeclarableObjectsError } from "../../core/undeclarable";
import { templateParts } from "../../core/template";

const config = { sql: { profiles: { prod: { url: "mysql://db:3306/shop" } } } };

/** The generated `schema.ts`'s templates, each back as the statement its tag would see (references as their names). */
function statementsOf(content: string): string[] {
  const out: string[] = [];
  for (const m of content.matchAll(/= (?:database|table|view)(?:<[^>]*>)?`\n([\s\S]*?)`;/g)) {
    const body = templateParts([m[1]!])[0]!.replace(/\$\{(\w+)\}/g, (_x, name: string) => (name.endsWith("Db") ? name.slice(0, -2) : name === "users" ? "shop.users" : name === "orders" ? "shop.orders" : name));
    out.push(body.trim());
  }
  return out;
}

describe("import from a live MySQL schema (#5449)", () => {
  test("writes each object as a declaration, what the server adds left out, and the marker never written", async () => {
    const server = fakeMysqlServer({ objects: SHOP_OBJECTS });
    const ir = await exportMysqlResources({ environment: "prod", config, connect: async () => server });
    expect(ir.resources.map((r) => [r.logicalId, r.type])).toEqual([
      ["shopDb", "MySQL::Database"],
      ["orders", "MySQL::Table"],
      ["paidOrders", "MySQL::View"],
      ["users", "MySQL::Table"],
    ]);
    const users = String(ir.resources[3]!.properties.ddl);
    expect(users).toContain("CREATE TABLE shop.`users`");
    expect(users).not.toContain("AUTO_INCREMENT=42");
    expect(users).not.toContain("[chant");
    expect(users).toContain("COMMENT = 'people who buy'");
    expect(users).toContain("`name` varchar(100),");
    expect(String(ir.resources[2]!.properties.ddl)).toMatch(/^CREATE VIEW shop\.`paid_orders` AS select/);
    expect(server.ended).toBe(true);
  });

  test("the generated declarations reference each other and round-trip to the same schema", async () => {
    const ir = await exportMysqlResources({ environment: "prod", config, connect: async () => fakeMysqlServer({ objects: SHOP_OBJECTS }) });
    const [file] = new MysqlGenerator().generate(ir);
    expect(file!.content).toContain('import { database, table, view } from "@intentius/chant-lexicon-sql/mysql";');
    expect(file!.content).toContain("CREATE TABLE ${shopDb}.users (");
    expect(file!.content).toContain("REFERENCES ${users} (id)");
    expect(file!.content).toContain("from ${orders} where");
    expect(file!.content.indexOf("export const users")).toBeLessThan(file!.content.indexOf("export const orders"));
    // Read back, the declarations plan no change against the server they came from.
    const declared = statementsOf(file!.content).map((s) => canonicalObject(s, "shop"));
    const live = SHOP_OBJECTS.map((o) => canonicalObject(o.statement, o.database ?? "shop"));
    const keyed = (cs: typeof live) => cs.map((c) => ({ key: objectKey(c), canonical: c }));
    expect(diffMysqlSchemas(keyed(live), keyed(declared)).changes).toEqual([]);
  });

  test("an object of a kind chant cannot declare fails the import, naming it; skipUndeclarable lists it", async () => {
    const probes = { TRIGGERS: [{ db: "shop", name: "orders_audit ON orders" }], PARTITIONS: [{ db: "shop", name: "orders" }] };
    const err = await exportMysqlResources({ environment: "prod", config, connect: async () => fakeMysqlServer({ objects: SHOP_OBJECTS, probes }) }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UndeclarableObjectsError);
    expect((err as Error).message).toContain("the MySQL server has 2 objects of a kind chant cannot declare");
    expect((err as Error).message).toContain("trigger shop.orders_audit ON orders");
    const ir = await exportMysqlResources({ environment: "prod", config, skipUndeclarable: true, connect: async () => fakeMysqlServer({ objects: SHOP_OBJECTS, probes }) });
    expect(ir.resources.map((r) => r.logicalId)).not.toContain("orders");
    expect(ir.warnings?.some((w) => w.includes("partitioned table shop.orders is left out"))).toBe(true);
  });

  test("owned keeps the tables carrying chant's marker; a migration tool's table is left out with a warning", async () => {
    const objects = [...SHOP_OBJECTS, { kind: "table" as const, database: "shop", name: "schema_migrations", statement: "CREATE TABLE `schema_migrations` (\n  `version` varchar(255) NOT NULL\n)", comment: "" }];
    const all = await exportMysqlResources({ environment: "prod", config, connect: async () => fakeMysqlServer({ objects }) });
    expect(all.resources.map((r) => r.logicalId)).not.toContain("schemaMigrations");
    expect(all.warnings).toContain("shop.schema_migrations is kept by a migration runner (Rails, golang-migrate, dbmate); left out, since declaring it would have chant change what that tool owns");
    const owned = await exportMysqlResources({ environment: "prod", config, owned: true, connect: async () => fakeMysqlServer({ objects }) });
    expect(owned.resources.map((r) => r.logicalId)).toEqual(["orders", "users"]);
  });

  test("a MariaDB server is refused", async () => {
    await expect(exportMysqlResources({ environment: "prod", config, connect: async () => fakeMysqlServer({ version: "11.4.2-MariaDB", objects: SHOP_OBJECTS }) })).rejects.toThrow(/MariaDB/);
  });

  test("stripServerDefaults keeps a statement it cannot parse as it is", () => {
    expect(stripServerDefaults("CREATE TRIGGER t BEFORE INSERT ON x FOR EACH ROW SET NEW.a = 1")).toBe("CREATE TRIGGER t BEFORE INSERT ON x FOR EACH ROW SET NEW.a = 1");
    expect(stripServerDefaults(ORDERS_TABLE)).not.toContain("DEFAULT NULL");
  });
});

describe("a file of MySQL DDL (#5449)", () => {
  const dump = [
    "/*!40101 SET NAMES utf8mb4 */;",
    SHOP_SOURCE.database,
    SHOP_SOURCE.users,
    "CREATE INDEX users_name ON shop.users (name)",
    SHOP_SOURCE.orders,
    SHOP_SOURCE.paidOrders,
  ].join(";\n");

  test("is read as MySQL by its marks, and a CREATE INDEX is read into its table", () => {
    const ir = new SqlFileParser(undefined).parse(`${dump.replace("ENGINE = InnoDB", "ENGINE=InnoDB")};`);
    expect(ir.resources.map((r) => r.type)).toEqual(["MySQL::Database", "MySQL::Table", "MySQL::Table", "MySQL::View"]);
    expect(String(ir.resources[1]!.properties.ddl)).toMatch(/UNIQUE KEY users_email \(email\),\n {2}KEY users_name \(name\)\n {2}\) ENGINE=InnoDB/);
  });

  test("an index on a table the file does not create is a problem naming it", () => {
    expect(() => readSqlFile("mysql", "CREATE INDEX i ON shop.t (a)", { origin: "schema.sql" })).toThrow(/creates an index on shop\.t, which the file does not create before it/);
  });

  test("a build's .sql file declares entities that reference each other", () => {
    const entities = sqlFileEntities("mysql", [{ origin: "schema.sql", ddl: [SHOP_SOURCE.database, SHOP_SOURCE.users, SHOP_SOURCE.orders].join(";\n") }]);
    expect([...entities.keys()]).toEqual(["shopDb", "users", "orders"]);
    expect((entities.get("orders") as unknown as { dependsOn: unknown[] }).dependsOn).toContain(entities.get("users"));
  });
});
