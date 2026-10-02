import { describe, expect, test } from "vitest";
import { isDeclarable } from "@intentius/chant/declarable";
import { buildDependencyGraph } from "@intentius/chant/discovery/graph";
import { database, isColumnRef, literal, table, view, SqlTemplateError } from "./entities";

const users = table`
  CREATE TABLE users (
    id     UUID,
    email  String,
    plan   LowCardinality(String)
  )
  ENGINE = ReplacingMergeTree
  ORDER BY id`;

const events = table`
  CREATE TABLE events (
    user_id  UUID,
    kind     LowCardinality(String),
    ts       DateTime
  )
  ENGINE = MergeTree
  ORDER BY (user_id, kind, ts)`;

const activeUsers = view`
  CREATE MATERIALIZED VIEW active_users
  ENGINE = AggregatingMergeTree ORDER BY ${events.columns.user_id} AS
  SELECT ${events.columns.user_id}, count() AS n
  FROM ${events}
  GROUP BY ${events.columns.user_id}`;

describe("the #3047 example", () => {
  test("each tag is one declarable entity of its ClickHouse type", () => {
    expect(isDeclarable(users)).toBe(true);
    expect(users.entityType).toBe("ClickHouse::Table");
    expect(activeUsers.entityType).toBe("ClickHouse::MaterializedView");
    expect(users.lexicon).toBe("sql");
  });

  test("a table's props are its parsed definition", () => {
    expect(events.props.name).toBe("events");
    expect(events.props.columns.map((c) => [c.name, c.type])).toEqual([
      ["user_id", "UUID"],
      ["kind", "LowCardinality(String)"],
      ["ts", "DateTime"],
    ]);
    expect(events.props.engine).toEqual({ name: "MergeTree" });
    expect(events.props.orderBy).toBe("(user_id, kind, ts)");
  });

  test("columns are references, reached through .columns", () => {
    expect(isColumnRef(events.columns.kind)).toBe(true);
    expect(events.columns.kind!.attribute).toBe("kind");
    // `kind` on the entity itself is the Declarable's own field, which is why columns live under `.columns`.
    expect(events.kind).toBe("resource");
  });

  test("a view records what it reads and its column lineage", () => {
    expect(activeUsers.props.reads).toEqual([events]);
    expect(activeUsers.props.lineage.map((e) => ({ output: e.output, expr: e.expr, from: e.from.map((r) => r.attribute) }))).toEqual([
      { output: "user_id", expr: "user_id", from: ["user_id"] },
      { output: "n", expr: "count()", from: [] },
    ]);
    expect(Object.keys(activeUsers.columns)).toEqual(["user_id", "n"]);
  });

  test("references render into the DDL as names", () => {
    expect(activeUsers.props.ddl).toContain("ORDER BY user_id AS");
    expect(activeUsers.props.ddl).toContain("FROM events");
  });

  test("the references are dependency edges core's graph sees", () => {
    const graph = buildDependencyGraph(new Map<string, never>([["users", users as never], ["events", events as never], ["activeUsers", activeUsers as never]]));
    expect([...graph.get("activeUsers")!]).toEqual(["events"]);
    expect([...graph.get("events")!]).toEqual([]);
  });

  test("the raw template parts are kept for a source round trip", () => {
    expect(users.props.source.strings.join("")).toContain("ReplacingMergeTree");
  });
});

describe("what an interpolation means", () => {
  test("a string is SQL text, spliced before parsing", () => {
    const name = "orders";
    const engine = "ReplacingMergeTree(version)";
    const t = table`CREATE TABLE ${name} (id UInt64, version UInt32) ENGINE = ${engine} ORDER BY id`;
    expect(t.props.name).toBe("orders");
    expect(t.props.engine).toEqual({ name: "ReplacingMergeTree", args: ["version"] });
  });

  test("a number is a numeric literal", () => {
    const days = 30;
    const t = table`CREATE TABLE t (ts DateTime) ENGINE = MergeTree ORDER BY ts TTL ts + INTERVAL ${days} DAY`;
    expect(t.props.ttl).toBe("ts + INTERVAL 30 DAY");
  });

  test("literal() is a quoted, escaped string value", () => {
    const plan = "free's";
    const t = table`CREATE TABLE t (plan String DEFAULT ${literal(plan)}) ENGINE = Log`;
    expect(t.props.columns[0]!.default).toEqual({ kind: "DEFAULT", expr: "'free\\'s'" });
  });

  test("a database entity qualifies a table's name", () => {
    const analytics = database`CREATE DATABASE analytics ENGINE = Atomic`;
    const t = table`CREATE TABLE ${analytics}.events (a UInt8) ENGINE = Log`;
    expect(t.props.database).toBe("analytics");
    expect(t.sqlName).toBe("analytics.events");
    expect(t.dependsOn).toEqual([analytics]);
  });

  test("a materialized view's TO target is the entity when it is declared", () => {
    const dst = table`CREATE TABLE dst (n UInt64) ENGINE = SummingMergeTree ORDER BY tuple()`;
    const mv = view`CREATE MATERIALIZED VIEW mv TO ${dst} AS SELECT count() AS n FROM ${events}`;
    expect(mv.props.to).toBe(dst);
  });

  test("undefined is refused, naming .columns", () => {
    const e = events as unknown as Record<string, unknown>;
    expect(() => view`CREATE VIEW v AS SELECT ${e.user_id} FROM ${events}`).toThrow(/\.columns/);
  });

  test("an object is refused with the template line", () => {
    expect(() => table`CREATE TABLE t (
      a UInt8 DEFAULT ${{}}) ENGINE = Log`).toThrow(/template line 2/);
  });

  test("text a string splices in is parsed, and its errors name the interpolation", () => {
    const bad = "Strin g";
    expect(() => table`CREATE TABLE t (a ${bad}) ENGINE = Log`).toThrow(/interpolated on template line 1/);
  });
});

describe("refusals", () => {
  test("a tag holding another statement names the right tag", () => {
    expect(() => table`CREATE VIEW v AS SELECT 1`).toThrow(/use the view tag/);
  });

  test("a syntax error says which template line it is on", () => {
    try {
      table`CREATE TABLE t (
        a UInt8,
        b Strin g
      ) ENGINE = Log`;
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(SqlTemplateError);
      expect((err as Error).message).toMatch(/template line 3/);
    }
  });

  test("a backslash is read raw, as written", () => {
    const t = table`CREATE TABLE t (re String DEFAULT '\d+\t') ENGINE = Log`;
    expect(t.props.columns[0]!.default!.expr).toBe("'\\d+\\t'");
  });
});
