/**
 * Sectioned by the serializer test table in lexicon-authoring/serializer.mdx.
 * Cases 5, 6, 8 and 9 (a derived name, an explicit name, injected defaults)
 * do not apply: a schema object's name is the one its DDL gives, and the
 * serializer adds nothing the DDL does not say.
 */
import { describe, expect, test } from "vitest";
import { DECLARABLE_MARKER, type Declarable } from "@intentius/chant/declarable";
import type { SerializerResult } from "@intentius/chant/serializer";
import { CLICKHOUSE_DDL_FILE, POSTGRES_DDL_FILE, sqlSerializer } from "./serializer";
import { database, table, view } from "./clickhouse/entities";
import * as pg from "./postgres/entities";

const analytics = database`CREATE DATABASE analytics ENGINE = Atomic`;
const events = table`
  CREATE TABLE ${analytics}.events (user_id UUID, kind LowCardinality(String), ts DateTime)
  ENGINE = MergeTree ORDER BY (user_id, ts)`;
const byKind = view`
  CREATE VIEW ${analytics}.by_kind AS
  SELECT ${events.columns.kind} AS kind, count() AS n FROM ${events} GROUP BY kind`;

const run = (entries: Array<[string, Declarable]>) => sqlSerializer.serialize(new Map(entries)) as SerializerResult;
const doc = (r: SerializerResult) =>
  JSON.parse(r.primary) as { dialect: string; applyOrder: string[]; objects: Array<Record<string, unknown>> };

describe("sql serializer", () => {
  test("1. its name is the lexicon's", () => {
    expect(sqlSerializer.name).toBe("sql");
  });

  test("2. its rule prefix is SQL", () => {
    expect(sqlSerializer.rulePrefix).toBe("SQL");
  });

  test("3. an empty build serializes to an empty string", () => {
    expect(sqlSerializer.serialize(new Map())).toBe("");
  });

  test("4. one table is filed under its export name, with its DDL", () => {
    const d = doc(run([["events", events]]));
    expect(d.dialect).toBe("clickhouse");
    expect(d.objects[0]).toMatchObject({ export: "events", type: "ClickHouse::Table", name: "events", sqlName: "analytics.events" });
    expect(d.objects[0]!.ddl).toMatch(/^CREATE TABLE analytics\.events/);
  });

  test("7. several objects come out in dependency order, the statements beside them in the same order", () => {
    const r = run([["byKind", byKind], ["events", events], ["analytics", analytics]]);
    expect(doc(r).applyOrder).toEqual(["analytics", "events", "byKind"]);
    const sql = r.files![CLICKHOUSE_DDL_FILE]!;
    expect(sql.indexOf("CREATE DATABASE")).toBeLessThan(sql.indexOf("CREATE TABLE"));
    expect(sql.indexOf("CREATE TABLE")).toBeLessThan(sql.indexOf("CREATE VIEW"));
    expect(r.verbatimFiles).toEqual([CLICKHOUSE_DDL_FILE]);
  });

  test("10. a declarable of another lexicon is not written", () => {
    const other = { [DECLARABLE_MARKER]: true, lexicon: "k8s", entityType: "K8s::Core::ConfigMap", kind: "resource", props: {} } as unknown as Declarable;
    expect(doc(run([["events", events], ["cm", other]])).applyOrder).toEqual(["events"]);
  });

  test("11. the output is the same whatever order the entities arrive in", () => {
    const a = run([["analytics", analytics], ["events", events], ["byKind", byKind]]);
    const b = run([["byKind", byKind], ["analytics", analytics], ["events", events]]);
    expect(a.primary).toBe(b.primary);
    expect(a.files).toEqual(b.files);
  });

  test("12. references are written as export names, lineage as export.column", () => {
    const view = doc(run([["analytics", analytics], ["events", events], ["byKind", byKind]])).objects.find((o) => o.export === "byKind")!;
    expect(view.reads).toEqual(["events"]);
    expect(view.dependsOn).toEqual(["analytics", "events.kind", "events"]);
    expect(view.lineage).toEqual([
      { output: "kind", expr: "kind", from: ["events.kind"] },
      { output: "n", expr: "count()", from: [] },
    ]);
    expect(view.source).toBeUndefined();
  });

  test("a reference cycle is an error naming it", () => {
    const a = table`CREATE TABLE a (x UInt8) ENGINE = Log`;
    const b = view`CREATE VIEW b AS SELECT * FROM ${a}`;
    // A cycle cannot be written with tags (a reference must exist first), so make one by hand.
    (a.dependsOn as unknown[]).push(b);
    expect(() => run([["a", a], ["b", b]])).toThrow(/reference cycle.*a -> b -> a/);
  });
});

describe("sql serializer, Postgres", () => {
  const app = pg.schema`CREATE SCHEMA app`;
  const users = pg.table`CREATE TABLE ${app}.users (id bigint PRIMARY KEY, email text NOT NULL)`;
  const orders = pg.table`
    CREATE TABLE ${app}.orders (id bigint PRIMARY KEY, user_id bigint REFERENCES ${users} (${users.columns.id}));
    COMMENT ON TABLE ${app}.orders IS 'Placed orders'`;
  const byUser = pg.index`CREATE INDEX orders_user_idx ON ${orders} (${orders.columns.user_id})`;

  test("4. a Postgres build is its own document, with postgres.sql beside it", () => {
    const r = run([["users", users], ["app", app]]);
    expect(doc(r).dialect).toBe("postgres");
    expect(doc(r).objects[1]).toMatchObject({ export: "users", type: "Postgres::Table", name: "users", schema: "app", sqlName: "app.users" });
    expect(r.files![POSTGRES_DDL_FILE]).toBe("CREATE SCHEMA app;\n\nCREATE TABLE app.users (id bigint PRIMARY KEY, email text NOT NULL);\n");
    expect(r.verbatimFiles).toEqual([POSTGRES_DDL_FILE]);
  });

  test("a Postgres build records the target major: sql.postgresMajor, else the newest pinned", () => {
    const entities = new Map<string, never>([["app", app as never]]);
    const major = (config?: Record<string, unknown>) =>
      (JSON.parse((sqlSerializer.serialize(entities, undefined, { config }) as SerializerResult).primary) as { postgresMajor?: number }).postgresMajor;
    expect(major()).toBe(18);
    expect(major({ sql: { postgresMajor: 14 } })).toBe(14);
  });

  test("7. an index comes after its table, a table after what it references, comments stay with their object", () => {
    const r = run([["byUser", byUser], ["orders", orders], ["users", users], ["app", app]]);
    expect(doc(r).applyOrder).toEqual(["app", "users", "orders", "byUser"]);
    expect(r.files![POSTGRES_DDL_FILE]).toContain("COMMENT ON TABLE app.orders IS 'Placed orders';\n\nCREATE INDEX");
  });

  test("12. references nested in props are written as export names", () => {
    const d = doc(run([["app", app], ["users", users], ["orders", orders], ["byUser", byUser]]));
    expect(d.objects.find((o) => o.export === "orders")!.foreignKeys).toEqual([
      { columns: ["user_id"], references: "users", refTable: "app.users", refColumns: ["id"] },
    ]);
    expect(d.objects.find((o) => o.export === "byUser")).toMatchObject({ table: "orders", tableName: "app.orders" });
  });

  test("one build holds one dialect", () => {
    expect(() => run([["events", events], ["users", users]])).toThrow(/one build holds one dialect.*ClickHouse \(events\) and Postgres \(users\)/);
  });
});
