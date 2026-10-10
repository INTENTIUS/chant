import { describe, expect, test } from "vitest";
import { canonicalCodec, canonicalExpression, canonicalObject, canonicalTtl, canonicalType } from "./normalize";
import { diffSchemas, type SchemaObject } from "./diff";
import { renderDiff } from "./report";
import { CLASSIFIER_RULES } from "./rules";

const DECLARED_EVENTS = `CREATE TABLE analytics.events (
  user_id UUID,
  kind LowCardinality(String),
  ts DateTime CODEC(Delta, ZSTD),
  props Map(String, String),
  n Nullable(UInt32) DEFAULT 1 COMMENT 'c',
  INDEX k kind TYPE bloom_filter(0.01) GRANULARITY 4
)
ENGINE = MergeTree
PARTITION BY toYYYYMM(ts)
ORDER BY (user_id, kind, ts)
TTL ts + INTERVAL 180 DAY DELETE
SETTINGS index_granularity = 8192
COMMENT 'events table'`;

// What clickhouse-server 26.8.15.10 prints for DECLARED_EVENTS.
const SHOWN_EVENTS = `CREATE TABLE analytics.events
(
    \`user_id\` UUID,
    \`kind\` LowCardinality(String),
    \`ts\` DateTime CODEC(Delta(4), ZSTD(1)),
    \`props\` Map(String, String),
    \`n\` Nullable(UInt32) DEFAULT 1 COMMENT 'c',
    INDEX k kind TYPE bloom_filter(0.01) GRANULARITY 4
)
ENGINE = MergeTree
PARTITION BY toYYYYMM(ts)
ORDER BY (user_id, kind, ts)
TTL ts + toIntervalDay(180)
SETTINGS index_granularity = 8192
COMMENT 'events table'`;

const DECLARED_MV = "CREATE MATERIALIZED VIEW analytics.daily_mv TO analytics.daily AS SELECT toDate(ts) AS day, kind, uniqState(user_id) AS users FROM analytics.events GROUP BY day, kind";
const SHOWN_MV = `CREATE MATERIALIZED VIEW analytics.daily_mv TO analytics.daily
(
    \`day\` Date,
    \`kind\` LowCardinality(String),
    \`users\` AggregateFunction(uniq, UUID)
)
AS SELECT
    toDate(ts) AS day,
    kind,
    uniqState(user_id) AS users
FROM analytics.events
GROUP BY
    day,
    kind`;

const obj = (key: string, ddl: string): SchemaObject => ({ key, canonical: canonicalObject(ddl) });

describe("normalization", () => {
  test("what the server prints for a declaration compares equal to the declaration", () => {
    const noText = (o: ReturnType<typeof canonicalObject>) => ({ ...o, columns: o.columns.map(({ text: _, ...c }) => c) });
    expect(noText(canonicalObject(SHOWN_EVENTS))).toEqual(noText(canonicalObject(DECLARED_EVENTS)));
    const shown = canonicalObject(SHOWN_MV);
    const declared = canonicalObject(DECLARED_MV);
    expect(shown.select).toBe(declared.select);
    expect(shown.to).toBe(declared.to);
    expect(diffSchemas([obj("e", SHOWN_EVENTS), obj("m", SHOWN_MV)], [obj("e", DECLARED_EVENTS), obj("m", DECLARED_MV)]).changes).toEqual([]);
  });

  test("the server's rewrites are undone", () => {
    expect(canonicalExpression("ts + INTERVAL 1 DAY")).toBe(canonicalExpression("ts + toIntervalDay(1)"));
    expect(canonicalExpression("ts+interval 2 hours")).toBe(canonicalExpression("ts + toIntervalHour(2)"));
    expect(canonicalExpression("(id)")).toBe("id");
    expect(canonicalExpression("tuple()")).toBe("");
    expect(canonicalExpression("analytics.events", "analytics")).toBe("events");
    expect(canonicalType("int")).toBe("Int32");
    expect(canonicalType("Nullable(BIGINT)")).toBe("Nullable ( Int64 )");
    expect(canonicalCodec("Delta(8), ZSTD(1)")).toBe(canonicalCodec("Delta, ZSTD"));
    expect(canonicalCodec("ZSTD(3)")).not.toBe(canonicalCodec("ZSTD"));
    expect(canonicalTtl("d + INTERVAL 1 MONTH DELETE, d + INTERVAL 1 WEEK TO VOLUME 'cold'")).toBe(
      canonicalTtl("d + toIntervalMonth(1), d + toIntervalWeek(1) TO VOLUME 'cold'"),
    );
  });

  test("a Replicated*MergeTree with no arguments is the one the server prints with its default Keeper path and replica", () => {
    const shown = (engine: string) => canonicalObject(`CREATE TABLE t (a UInt8, v UInt8) ENGINE = ${engine} ORDER BY a`).engine;
    expect(shown("ReplicatedMergeTree('/clickhouse/tables/{uuid}/{shard}', '{replica}')")).toBe(shown("ReplicatedMergeTree"));
    expect(shown("ReplicatedReplacingMergeTree('/clickhouse/tables/{uuid}/{shard}', '{replica}', v)")).toBe(shown("ReplicatedReplacingMergeTree(v)"));
    expect(shown("ReplicatedMergeTree('/clickhouse/tables/{shard}/t', '{replica}')")).not.toBe(shown("ReplicatedMergeTree"));
  });

  test("a Distributed engine's cluster, database and table read the same quoted or not (#3664)", () => {
    const shown = (engine: string) => canonicalObject(`CREATE TABLE d.events_all (id UInt64) ENGINE = ${engine}`).engine;
    expect(shown("Distributed(my_cluster, d, events, id)")).toBe(shown("Distributed('my_cluster', 'd', 'events', id)"));
    expect(shown("Distributed(`my_cluster`, `d`, `events`)")).toBe(shown("Distributed('my_cluster', 'd', 'events')"));
    expect(shown("Distributed('{cluster}', currentDatabase(), events, rand())")).toBe(shown("Distributed('{cluster}', currentDatabase(), 'events', rand())"));
    // The sharding key is an expression, not a name: it stays as written.
    expect(shown("Distributed(c, d, events, id)")).not.toBe(shown("Distributed(c, d, events, 'id')"));
    expect(shown("Distributed(c, d, events)")).not.toBe(shown("Distributed(c, d, other)"));
  });

  test("a setting at its default is not part of the definition", () => {
    expect(canonicalObject("CREATE TABLE t (a UInt8) ENGINE = MergeTree ORDER BY a SETTINGS index_granularity = 8192").settings).toEqual({});
    expect(canonicalObject("CREATE TABLE t (a UInt8) ENGINE = MergeTree ORDER BY a SETTINGS min_bytes_for_wide_part = '0'").settings).toEqual({ min_bytes_for_wide_part: "0" });
  });
});

const BASE = "CREATE TABLE events (id UInt64, kind String, ts DateTime, n UInt32) ENGINE = MergeTree PARTITION BY toYYYYMM(ts) ORDER BY (id, ts)";

function classify(after: string, before = BASE) {
  return diffSchemas([obj("events", before)], [obj("events", after)]).changes.map((c) => [c.field, c.rule, c.class]);
}

describe("classifying a change", () => {
  test("adding a column is metadata only", () => {
    expect(classify(BASE.replace("n UInt32)", "n UInt32, extra String)"))).toEqual([["columns.extra", "SQLCH201", "metadata"]]);
  });

  test("dropping a column destroys its data; a key column cannot be dropped", () => {
    const d = diffSchemas([obj("events", BASE)], [obj("events", BASE.replace(", n UInt32", ""))]).changes;
    expect(d.map((c) => [c.rule, c.destructive])).toEqual([["SQLCH202", true]]);
    expect(classify(BASE.replace("kind String, ", "").replace("(id, ts)", "(id, ts)"))[0]).toEqual(["columns.kind", "SQLCH202", "metadata"]);
    expect(classify(BASE.replace("id UInt64, ", "").replace("(id, ts)", "ts"))).toContainEqual(["columns.id", "SQLCH213", "rebuild"]);
  });

  test("a type change rewrites in the background, or needs a rebuild for a key column", () => {
    expect(classify(BASE.replace("n UInt32", "n UInt64"))).toEqual([["columns.n.type", "SQLCH210", "rewrite"]]);
    expect(classify(BASE.replace("ts DateTime", "ts DateTime64(3)"))).toEqual([["columns.ts.type", "SQLCH211", "rebuild"]]);
  });

  test("a renamed column says so with previously; in a key it is a rebuild", () => {
    expect(classify(BASE.replace("kind String,", "event_kind String, -- previously: kind\n"))).toEqual([["columns.event_kind", "SQLCH212", "metadata"]]);
    expect(classify(BASE.replace("id UInt64,", "user_id UInt64, -- previously: id\n").replace("(id, ts)", "(user_id, ts)"))).toContainEqual([
      "columns.user_id",
      "SQLCH213",
      "rebuild",
    ]);
  });

  test("without the hint a rename is a drop and an add, and a hint says so", () => {
    const d = diffSchemas([obj("events", BASE)], [obj("events", BASE.replace("kind String", "event_kind String"))]);
    expect(d.changes.map((c) => c.rule).sort()).toEqual(["SQLCH201", "SQLCH202"]);
    expect(d.hints[0]).toMatch(/-- previously: kind/);
  });

  test("the sorting key: appending a new column keeping the primary key is an ALTER, anything else a rebuild", () => {
    expect(classify(BASE.replace("n UInt32)", "n UInt32, k2 String)").replace("ORDER BY (id, ts)", "PRIMARY KEY (id, ts) ORDER BY (id, ts, k2)"))).toEqual([
      ["columns.k2", "SQLCH201", "metadata"],
      ["orderBy", "SQLCH216", "metadata"],
    ]);
    expect(classify(BASE.replace("(id, ts)", "(ts, id)"))).toEqual([["orderBy", "SQLCH220", "rebuild"]]);
  });

  test("the partition key, the engine and the primary key need a rebuild", () => {
    expect(classify(BASE.replace("toYYYYMM(ts)", "toDate(ts)"))).toEqual([["partitionBy", "SQLCH222", "rebuild"]]);
    expect(classify(BASE.replace("ENGINE = MergeTree", "ENGINE = ReplacingMergeTree(ts)"))).toEqual([["engine", "SQLCH223", "rebuild"]]);
    expect(classify(BASE.replace("ORDER BY", "PRIMARY KEY id ORDER BY"))).toEqual([["primaryKey", "SQLCH221", "rebuild"]]);
  });

  test("TTL rewrites; settings change in place unless fixed at creation; indexes and comments are metadata", () => {
    expect(classify(`${BASE} TTL ts + INTERVAL 1 DAY`)).toEqual([["ttl", "SQLCH205", "rewrite"]]);
    expect(classify(`${BASE} SETTINGS merge_with_ttl_timeout = 3600`)).toEqual([["settings.merge_with_ttl_timeout", "SQLCH206", "metadata"]]);
    expect(classify(`${BASE} SETTINGS index_granularity = 1024`)).toEqual([["settings.index_granularity", "SQLCH218", "rebuild"]]);
    expect(classify(BASE.replace("n UInt32)", "n UInt32, INDEX ix kind TYPE set(10) GRANULARITY 1)"))).toEqual([["indexes.ix", "SQLCH204", "metadata"]]);
    expect(classify(`${BASE} COMMENT 'x'`)).toEqual([["comment", "SQLCH203", "metadata"]]);
  });

  test("a renamed table under the same export is a RENAME", () => {
    expect(classify(BASE.replace("CREATE TABLE events", "CREATE TABLE raw_events"))).toEqual([["name", "SQLCH230", "metadata"]]);
  });

  test("views: a plain view's query is replaced; a materialized view's query is modified, its target fixed", () => {
    const v = "CREATE VIEW v AS SELECT id FROM events";
    expect(classify("CREATE VIEW v AS SELECT id, ts FROM events", v)).toEqual([["select", "SQLCH240", "metadata"]]);
    const mv = "CREATE MATERIALIZED VIEW m TO dst AS SELECT id FROM events";
    expect(classify("CREATE MATERIALIZED VIEW m TO dst AS SELECT id + 1 AS id FROM events", mv)).toEqual([["select", "SQLCH241", "metadata"]]);
    expect(classify("CREATE MATERIALIZED VIEW m TO dst2 AS SELECT id FROM events", mv)).toEqual([["to", "SQLCH242", "rebuild"]]);
  });

  test("objects appear and disappear; a table becoming a view is a rebuild", () => {
    const d = diffSchemas([obj("a", BASE)], [obj("b", "CREATE VIEW b AS SELECT 1")]);
    expect(d.changes.map((c) => [c.object, c.rule])).toEqual([
      ["b", "SQLCH200"],
      ["a", "SQLCH250"],
    ]);
    expect(classify("CREATE VIEW events AS SELECT 1")).toEqual([["kind", "SQLCH224", "rebuild"]]);
  });

  test("against a server, previously before the statement matches the old name", () => {
    const live = [{ key: "default.events", canonical: canonicalObject(BASE) }];
    const declared = [{ key: "default.raw_events", canonical: canonicalObject(`-- previously: events\n${BASE.replace("TABLE events", "TABLE raw_events")}`) }];
    expect(diffSchemas(live, declared).changes.map((c) => c.rule)).toEqual(["SQLCH230"]);
  });
});

describe("the rules", () => {
  test("every rule names a class, a restriction and a ClickHouse documentation page", () => {
    for (const [id, r] of Object.entries(CLASSIFIER_RULES)) {
      expect(r.id).toBe(id);
      expect(r.restriction.length).toBeGreaterThan(20);
      expect(r.cite).toMatch(/^https:\/\/clickhouse\.com\/docs\//);
    }
  });

  test("a rebuild is refused in the report", () => {
    const d = diffSchemas([obj("events", BASE)], [obj("events", BASE.replace("(id, ts)", "(ts, id)"))]);
    expect(d.rebuilds).toHaveLength(1);
    const text = renderDiff(d);
    expect(text).toMatch(/\[REBUILD\] orderBy/);
    expect(text).toMatch(/Refused: 1 change\(s\) need a rebuild/);
    expect(text).toContain("https://clickhouse.com/docs/sql-reference/statements/alter/order-by");
  });
});
