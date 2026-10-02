/**
 * Sectioned by the serializer test table in lexicon-authoring/serializer.mdx.
 * Cases 5, 6, 8 and 9 (a derived name, an explicit name, injected defaults)
 * do not apply: a schema object's name is the one its DDL gives, and the
 * serializer adds nothing the DDL does not say.
 */
import { describe, expect, test } from "vitest";
import { DECLARABLE_MARKER, type Declarable } from "@intentius/chant/declarable";
import type { SerializerResult } from "@intentius/chant/serializer";
import { CLICKHOUSE_DDL_FILE, sqlSerializer } from "./serializer";
import { database, table, view } from "./clickhouse/entities";

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
