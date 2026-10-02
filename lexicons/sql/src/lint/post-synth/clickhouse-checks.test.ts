import { describe, expect, test } from "vitest";
import { makePostSynthCtx } from "@intentius/chant-test-utils";
import type { PostSynthCheck } from "@intentius/chant/lint/post-synth";
import type { SerializerResult } from "@intentius/chant/serializer";
import { sqlSerializer } from "../../serializer";
import { database, table, view } from "../../clickhouse/entities";
import { sqlAuditCatalog } from "../audit-catalog";
import { postSynthChecks } from "./index";

type Entities = Record<string, unknown>;

function run(id: string, entities: Entities) {
  const check = postSynthChecks.find((c: PostSynthCheck) => c.id === id)!;
  const out = sqlSerializer.serialize(new Map(Object.entries(entities)) as never) as SerializerResult;
  return check.check(makePostSynthCtx("sql", out.primary));
}

const flagged = (id: string, entities: Entities, text: RegExp) => {
  const diags = run(id, entities);
  expect(diags.length).toBeGreaterThan(0);
  expect(diags[0]).toMatchObject({ checkId: id, lexicon: "sql" });
  expect(diags[0]!.message).toMatch(text);
  return diags;
};

describe("registration", () => {
  test("at least 15 ClickHouse post-synth checks, each with an audit entry", () => {
    const ids = postSynthChecks.map((c) => c.id).filter((id) => /^SQLCH1\d\d$/.test(id));
    expect(ids.length).toBeGreaterThanOrEqual(15);
    for (const id of ids) expect(sqlAuditCatalog[id], id).toBeDefined();
  });

  test("the audit categories cover security and correctness and best practice", () => {
    const cats = new Set(Object.values(sqlAuditCatalog).filter((m) => m.yamlBased).map((m) => m.category));
    expect(cats).toEqual(new Set(["security", "correctness", "best-practice"]));
  });
});

describe("SQLCH102: PRIMARY KEY not a prefix of ORDER BY", () => {
  test("flags a primary key outside the sort key", () => {
    const t = table`CREATE TABLE t (a UInt8, b UInt8) ENGINE = MergeTree PRIMARY KEY b ORDER BY (a, b)`;
    flagged("SQLCH102", { t }, /not a prefix/);
  });
  test("a prefix, and no primary key, are clean", () => {
    const a = table`CREATE TABLE a (a UInt8, b UInt8) ENGINE = MergeTree PRIMARY KEY a ORDER BY (a, b)`;
    const b = table`CREATE TABLE b (a UInt8) ENGINE = MergeTree ORDER BY a`;
    expect(run("SQLCH102", { a, b })).toEqual([]);
  });
});

describe("SQLCH103: engine special column types", () => {
  test("flags a String version column", () => {
    const t = table`CREATE TABLE t (a UInt8, v String) ENGINE = ReplacingMergeTree(v) ORDER BY a`;
    flagged("SQLCH103", { t }, /version column v is String/);
  });
  test("flags a sign that is not Int8", () => {
    const t = table`CREATE TABLE t (a UInt8, s UInt8) ENGINE = CollapsingMergeTree(s) ORDER BY a`;
    flagged("SQLCH103", { t }, /sign column s/);
  });
  test("accepts a DateTime version and an Int8 sign", () => {
    const a = table`CREATE TABLE a (k UInt8, v DateTime) ENGINE = ReplacingMergeTree(v) ORDER BY k`;
    const b = table`CREATE TABLE b (k UInt8, s Int8) ENGINE = CollapsingMergeTree(s) ORDER BY k`;
    expect(run("SQLCH103", { a, b })).toEqual([]);
  });
});

describe("SQLCH104: engine argument names a missing column", () => {
  test("flags a version column the table lacks", () => {
    const t = table`CREATE TABLE t (a UInt8) ENGINE = ReplacingMergeTree(ver) ORDER BY a`;
    flagged("SQLCH104", { t }, /names column ver/);
  });
  test("a declared column is clean", () => {
    const t = table`CREATE TABLE t (a UInt8, ver UInt32) ENGINE = ReplacingMergeTree(ver) ORDER BY a`;
    expect(run("SQLCH104", { t })).toEqual([]);
  });
});

describe("SQLCH105: key clause names a missing column", () => {
  test("flags ORDER BY and PARTITION BY names", () => {
    const t = table`CREATE TABLE t (a UInt8) ENGINE = MergeTree PARTITION BY month ORDER BY (a, missing)`;
    const diags = run("SQLCH105", { t });
    expect(diags.map((d) => d.message).join("\n")).toMatch(/ORDER BY names column missing[\s\S]*PARTITION BY names column month/);
  });
  test("expressions and declared columns are clean", () => {
    const t = table`CREATE TABLE t (a UInt8, d Date) ENGINE = MergeTree PARTITION BY toYYYYMM(d) ORDER BY (a, d)`;
    expect(run("SQLCH105", { t })).toEqual([]);
  });
});

describe("SQLCH106: skip index names a missing column", () => {
  test("flags a column the table lacks", () => {
    const t = table`CREATE TABLE t (a String, INDEX i lower(nope) TYPE bloom_filter GRANULARITY 1) ENGINE = MergeTree ORDER BY a`;
    flagged("SQLCH106", { t }, /names nope/);
  });
  test("a declared column inside a call is clean", () => {
    const t = table`CREATE TABLE t (a String, INDEX i lower(a) TYPE bloom_filter GRANULARITY 1) ENGINE = MergeTree ORDER BY a`;
    expect(run("SQLCH106", { t })).toEqual([]);
  });
});

describe("SQLCH107: TTL on a non-date column", () => {
  test("flags a table TTL on a String column", () => {
    const t = table`CREATE TABLE t (a UInt8, s String) ENGINE = MergeTree ORDER BY a TTL s + INTERVAL 1 DAY`;
    flagged("SQLCH107", { t }, /table TTL is built on s/);
  });
  test("flags a column TTL on an integer", () => {
    const t = table`CREATE TABLE t (a UInt8, n UInt32 TTL n DELETE) ENGINE = MergeTree ORDER BY a`;
    expect(run("SQLCH107", { t }).length).toBeGreaterThan(0);
  });
  test("DateTime with an interval and an action is clean", () => {
    const t = table`CREATE TABLE t (a UInt8, d DateTime) ENGINE = MergeTree ORDER BY a TTL d + INTERVAL 1 DAY DELETE`;
    expect(run("SQLCH107", { t })).toEqual([]);
  });
});

describe("SQLCH108: OR REPLACE outside an Atomic database", () => {
  test("flags a replace in an Ordinary database", () => {
    const db = database`CREATE DATABASE app ENGINE = Ordinary`;
    const t = table`CREATE OR REPLACE TABLE app.t (a UInt8) ENGINE = MergeTree ORDER BY a`;
    flagged("SQLCH108", { db, t }, /Atomic or Replicated/);
  });
  test("Atomic is clean", () => {
    const db = database`CREATE DATABASE app ENGINE = Atomic`;
    const t = table`CREATE OR REPLACE TABLE app.t (a UInt8) ENGINE = MergeTree ORDER BY a`;
    expect(run("SQLCH108", { db, t })).toEqual([]);
  });
});

describe("SQLCH109: materialized view selects *", () => {
  test("flags a star", () => {
    const src = table`CREATE TABLE src (a UInt8) ENGINE = MergeTree ORDER BY a`;
    const mv = view`CREATE MATERIALIZED VIEW mv ENGINE = MergeTree ORDER BY a AS SELECT * FROM ${src}`;
    flagged("SQLCH109", { src, mv }, /selects \*/);
  });
  test("a column list is clean", () => {
    const src = table`CREATE TABLE src (a UInt8) ENGINE = MergeTree ORDER BY a`;
    const mv = view`CREATE MATERIALIZED VIEW mv ENGINE = MergeTree ORDER BY a AS SELECT ${src.columns.a} FROM ${src}`;
    expect(run("SQLCH109", { src, mv })).toEqual([]);
  });
});

describe("SQLCH110: view column missing from its TO target", () => {
  test("flags a selected column the target lacks", () => {
    const src = table`CREATE TABLE src (a UInt8, b UInt8) ENGINE = MergeTree ORDER BY a`;
    const tgt = table`CREATE TABLE tgt (a UInt8) ENGINE = MergeTree ORDER BY a`;
    const mv = view`CREATE MATERIALIZED VIEW mv TO ${tgt} AS SELECT ${src.columns.a}, ${src.columns.b} FROM ${src}`;
    flagged("SQLCH110", { src, tgt, mv }, /selects b/);
  });
  test("matching columns are clean", () => {
    const src = table`CREATE TABLE src (a UInt8, b UInt8) ENGINE = MergeTree ORDER BY a`;
    const tgt = table`CREATE TABLE tgt (a UInt8, b UInt8) ENGINE = MergeTree ORDER BY a`;
    const mv = view`CREATE MATERIALIZED VIEW mv TO ${tgt} AS SELECT ${src.columns.a}, ${src.columns.b} FROM ${src}`;
    expect(run("SQLCH110", { src, tgt, mv })).toEqual([]);
  });
});

describe("SQLCH111: String limited to a few values", () => {
  test("flags a CHECK ... IN on a String", () => {
    const t = table`CREATE TABLE t (s String, CONSTRAINT c CHECK s IN ('a', 'b')) ENGINE = MergeTree ORDER BY s`;
    flagged("SQLCH111", { t }, /LowCardinality/);
  });
  test("LowCardinality is clean", () => {
    const t = table`CREATE TABLE t (s LowCardinality(String), CONSTRAINT c CHECK s IN ('a', 'b')) ENGINE = MergeTree ORDER BY s`;
    expect(run("SQLCH111", { t })).toEqual([]);
  });
});

describe("SQLCH112: PARTITION BY finer than a day", () => {
  test("flags a bare DateTime and an hourly truncation", () => {
    const a = table`CREATE TABLE a (d DateTime) ENGINE = MergeTree PARTITION BY d ORDER BY d`;
    const b = table`CREATE TABLE b (d DateTime) ENGINE = MergeTree PARTITION BY toStartOfHour(d) ORDER BY d`;
    expect(run("SQLCH112", { a, b })).toHaveLength(2);
  });
  test("a month is clean", () => {
    const t = table`CREATE TABLE t (d DateTime) ENGINE = MergeTree PARTITION BY toYYYYMM(d) ORDER BY d`;
    expect(run("SQLCH112", { t })).toEqual([]);
  });
});

describe("SQLCH113: MergeTree with no sort key", () => {
  test("flags a missing ORDER BY", () => {
    const t = table`CREATE TABLE t (a UInt8) ENGINE = MergeTree`;
    flagged("SQLCH113", { t }, /no ORDER BY/);
  });
  test("ORDER BY tuple() and a non-MergeTree engine are clean", () => {
    const a = table`CREATE TABLE a (a UInt8) ENGINE = MergeTree ORDER BY tuple()`;
    const b = table`CREATE TABLE b (a UInt8) ENGINE = Memory`;
    expect(run("SQLCH113", { a, b })).toEqual([]);
  });
});

describe("SQLCH114: unknown codec", () => {
  test("flags a codec the pin lacks", () => {
    const t = table`CREATE TABLE t (a UInt8 CODEC(Snappy)) ENGINE = MergeTree ORDER BY a`;
    flagged("SQLCH114", { t }, /Snappy/);
  });
  test("known codecs with parameters are clean", () => {
    const t = table`CREATE TABLE t (a UInt8 CODEC(Delta, ZSTD(3))) ENGINE = MergeTree ORDER BY a`;
    expect(run("SQLCH114", { t })).toEqual([]);
  });
});

describe("SQLCH115: secret-named columns", () => {
  test("flags a password column with no marker", () => {
    const t = table`CREATE TABLE t (a UInt8, password String) ENGINE = MergeTree ORDER BY a`;
    flagged("SQLCH115", { t }, /password/);
  });
  test("a comment, a TTL or an encryption codec clears it", () => {
    const a = table`CREATE TABLE a (k UInt8, api_key String COMMENT 'hashed') ENGINE = MergeTree ORDER BY k`;
    const b = table`CREATE TABLE b (k UInt8, secret String CODEC(AES_256_GCM_SIV)) ENGINE = MergeTree ORDER BY k`;
    const c = table`CREATE TABLE c (k UInt8, d DateTime, token String) ENGINE = MergeTree ORDER BY k TTL d + INTERVAL 7 DAY`;
    expect(run("SQLCH115", { a, b, c })).toEqual([]);
  });
  test("an ordinary name is clean", () => {
    const t = table`CREATE TABLE t (a UInt8, tokens_used UInt32, passwords_reset UInt8) ENGINE = MergeTree ORDER BY a`;
    expect(run("SQLCH115", { t })).toEqual([]);
  });
});

describe("SQLCH116: DEFINER view without a definer", () => {
  test("flags SQL SECURITY DEFINER alone", () => {
    const v = view`CREATE VIEW v SQL SECURITY DEFINER AS SELECT 1 AS a`;
    flagged("SQLCH116", { v }, /no DEFINER/);
  });
  test("a named definer is clean", () => {
    const v = view`CREATE VIEW v DEFINER = reporter SQL SECURITY DEFINER AS SELECT 1 AS a`;
    expect(run("SQLCH116", { v })).toEqual([]);
  });
});

describe("SQLCH117: obsolete MergeTree setting", () => {
  test("flags a setting the pin marks obsolete", () => {
    const t = table`CREATE TABLE t (a UInt8) ENGINE = MergeTree ORDER BY a SETTINGS min_rows_for_compact_part = 10`;
    flagged("SQLCH117", { t }, /obsolete/);
  });
  test("a current setting is clean", () => {
    const t = table`CREATE TABLE t (a UInt8) ENGINE = MergeTree ORDER BY a SETTINGS index_granularity = 4096`;
    expect(run("SQLCH117", { t })).toEqual([]);
  });
});

describe("SQLCH118: unknown MergeTree setting", () => {
  test("flags a misspelled setting", () => {
    const t = table`CREATE TABLE t (a UInt8) ENGINE = MergeTree ORDER BY a SETTINGS index_granularty = 4096`;
    flagged("SQLCH118", { t }, /index_granularty/);
  });
  test("a known setting is clean", () => {
    const t = table`CREATE TABLE t (a UInt8) ENGINE = MergeTree ORDER BY a SETTINGS storage_policy = 'default'`;
    expect(run("SQLCH118", { t })).toEqual([]);
  });
});

describe("SQLCH119: deprecated or experimental engine", () => {
  test("flags the Ordinary database engine", () => {
    const db = database`CREATE DATABASE d ENGINE = Ordinary`;
    flagged("SQLCH119", { db }, /deprecated engine Ordinary/);
  });
  test("flags an experimental table engine", () => {
    const t = table`CREATE TABLE t (a UInt8) ENGINE = WindowView`;
    flagged("SQLCH119", { t }, /experimental engine WindowView/);
  });
  test("Atomic and MergeTree are clean", () => {
    const db = database`CREATE DATABASE d ENGINE = Atomic`;
    const t = table`CREATE TABLE t (a UInt8) ENGINE = MergeTree ORDER BY a`;
    expect(run("SQLCH119", { db, t })).toEqual([]);
  });
});

describe("SQLCH120: legacy MergeTree arguments", () => {
  test("flags the positional form", () => {
    const t = table`CREATE TABLE t (d Date, a UInt8) ENGINE = MergeTree(d, (a, d), 8192)`;
    flagged("SQLCH120", { t }, /positional/);
  });
  test("a bare MergeTree is clean", () => {
    const t = table`CREATE TABLE t (a UInt8) ENGINE = MergeTree ORDER BY a`;
    expect(run("SQLCH120", { t })).toEqual([]);
  });
});
