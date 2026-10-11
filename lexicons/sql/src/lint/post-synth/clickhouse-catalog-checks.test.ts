/**
 * SQLCH121 to SQLCH127 and SQL101 (#3750): column types, codec parameters,
 * grant columns and function calls against the pinned catalog, and the same
 * object declared twice. Each flagged case is one the probe found building
 * with exit 0; each clean case is a correct declaration that must stay clean.
 */
import { describe, expect, test } from "vitest";
import { makePostSynthCtx } from "@intentius/chant-test-utils";
import type { PostSynthCheck } from "@intentius/chant/lint/post-synth";
import type { SerializerResult } from "@intentius/chant/serializer";
import { sqlSerializer } from "../../serializer";
import { database, dictionary, func, grant, role, table, view } from "../../clickhouse/entities";
import { schema, table as pgTable, type as pgType } from "../../postgres/entities";
import { sqlAuditCatalog } from "../audit-catalog";
import { postSynthChecks } from "./index";
import { calledNames, isKnownFunction } from "./sqlch127";
import { typeFindings } from "./clickhouse-type-check";

type Entities = Record<string, unknown>;

function run(id: string, entities: Entities) {
  const check = postSynthChecks.find((c: PostSynthCheck) => c.id === id)!;
  const out = sqlSerializer.serialize(new Map(Object.entries(entities)) as never) as SerializerResult;
  return check.check(makePostSynthCtx("sql", out.primary));
}

const flagged = (id: string, entities: Entities, text: RegExp) => {
  const diags = run(id, entities);
  expect(diags.length, JSON.stringify(diags)).toBe(1);
  expect(diags[0]).toMatchObject({ checkId: id, lexicon: "sql", severity: "error" });
  expect(diags[0]!.message).toMatch(text);
  return diags[0]!;
};

const clean = (id: string, entities: Entities) => expect(run(id, entities)).toEqual([]);

const NEW = ["SQL101", "SQLCH121", "SQLCH122", "SQLCH123", "SQLCH124", "SQLCH125", "SQLCH126", "SQLCH127"];

const shop = database`CREATE DATABASE shop ENGINE = Atomic`;
/** One table with the column list given, in the probe's shape. */
const events = (columns: string) =>
  table`CREATE TABLE ${shop}.events (${columns as unknown as never}) ENGINE = MergeTree ORDER BY tuple()`;

describe("registration", () => {
  test("each new check is registered with an audit entry", () => {
    const ids = postSynthChecks.map((c) => c.id);
    for (const id of NEW) {
      expect(ids, id).toContain(id);
      expect(sqlAuditCatalog[id], id).toBeDefined();
    }
  });
});

/** Correct column types of every shape ClickHouse accepts. */
const CORRECT_TYPES = [
  "UInt64",
  "BIGINT UNSIGNED",
  "bigint",
  "Int32 UNSIGNED",
  "INT(11)",
  "UInt64(8)",
  "VARCHAR(255)",
  "String",
  "text",
  "datetime",
  "DOUBLE PRECISION",
  "Float64",
  "bool",
  "Bool",
  "LowCardinality(String)",
  "LowCardinality(Nullable(String))",
  "Array(Nullable(String))",
  "Array(Array(UInt8))",
  "Nullable(String)",
  "Map(String, UInt64)",
  "Map(LowCardinality(String), Array(Nullable(Float64)))",
  "Tuple(String, UInt8)",
  "Tuple(a String, b Nullable(UInt8))",
  "Tuple(date Date, `x y` String)",
  "Tuple()",
  "Nullable(Tuple(a String, b UInt8))",
  "Nested(x UInt8, y String)",
  "AggregateFunction(uniq, UInt64)",
  "AggregateFunction(quantiles(0.5, 0.9), Float64)",
  "AggregateFunction(count)",
  "AggregateFunction(argMax, String, DateTime)",
  "SimpleAggregateFunction(sum, UInt64)",
  "SimpleAggregateFunction(anyLast, Nullable(String))",
  "DateTime('UTC')",
  "DateTime64(3, 'UTC')",
  "DateTime64",
  "Decimal(18, 4)",
  "Decimal(76, 2)",
  "DECIMAL(10, 2)",
  "Decimal",
  "Decimal64(4)",
  "Enum8('a' = 1, 'b(' = 2)",
  "Enum('a', 'b')",
  "FixedString(16)",
  "UUID",
  "IPv4",
  "Variant(String, UInt64)",
  "JSON(max_dynamic_paths = 10, a.b UInt32)",
  "Dynamic(max_types = 8)",
  "String COLLATE utf8",
  "Point",
];

describe("SQLCH121, SQLCH122, SQLCH123: column types", () => {
  test.each(CORRECT_TYPES)("%s is clean", (type) => {
    expect(typeFindings(type, "test")).toEqual([]);
  });

  test("UInt46 is not a family (probe type-unknown)", () => {
    flagged("SQLCH121", { shop, events: events("id UInt46, at DateTime") }, /column id UInt46: UInt46 is not a type family ClickHouse \d/);
  });
  test("uint64 is case-sensitive (probe type-case)", () => {
    flagged("SQLCH121", { shop, events: events("id uint64") }, /uint64 is not a type family .* \(it has UInt64, and that name is case-sensitive\)/);
  });
  test("Nullabel(String) is not a family (probe wrapper-unknown)", () => {
    flagged("SQLCH121", { shop, events: events("id UInt64, note Nullabel(String)") }, /column note Nullabel\(String\): Nullabel is not/);
  });
  test.each(["Array(UInt46)", "Map(String, UInt46)", "Tuple(a UInt46)", "Nested(a UInt46)", "Nullable(UInt46)", "LowCardinality(UInt46)", "Variant(String, UInt46)", "AggregateFunction(uniq, UInt46)", "SimpleAggregateFunction(sum, UInt46)", "Array(Map(String, Array(UInt46)))"])(
    "a family is checked at every depth: %s",
    (type) => {
      expect(typeFindings(type, "test")).toEqual([{ checkId: "SQLCH121", detail: expect.stringMatching(/^UInt46 is not/) }]);
    },
  );
  test("FixedString with no length (probe type-params-missing)", () => {
    flagged("SQLCH122", { shop, events: events("id UInt64, code FixedString") }, /FixedString needs its length/);
  });
  test("Decimal(100, 2) (probe type-params-bad)", () => {
    flagged("SQLCH122", { shop, events: events("id UInt64, amount Decimal(100, 2)") }, /Decimal precision 100 is outside 1 to 76/);
  });
  test.each([
    ["UUID(4)", /UUID takes no parameters/],
    ["UInt64(8, 2)", /UInt64 takes at most 1 parameter/],
    ["Decimal(10, 2, 1)", /Decimal takes at most 2 parameters/],
    ["DateTime64(12)", /DateTime64 precision 12 is outside 0 to 9/],
    ["Map(String)", /Map needs its value/],
    ["Nullable", /Nullable needs its type/],
    ["Enum8", /Enum8 needs at least one member/],
    ["Array(FixedString)", /FixedString needs its length/],
  ])("parameters that do not fit: %s", (type, detail) => {
    expect(typeFindings(type, "test")).toEqual([{ checkId: "SQLCH122", detail: expect.stringMatching(detail) }]);
  });
  test("Nullable(LowCardinality(String)) (probe wrapper-order)", () => {
    flagged("SQLCH123", { shop, events: events("id UInt64, note Nullable(LowCardinality(String))") }, /Nullable cannot hold LowCardinality; write LowCardinality\(Nullable\(T\)\) instead/);
  });
  test("Nullable(Array(String)) (probe wrapper-nested-nullable)", () => {
    flagged("SQLCH123", { shop, events: events("id UInt64, tags Nullable(Array(String))") }, /Nullable cannot hold Array/);
  });
  test.each(["Nullable(Map(String, UInt8))", "Nullable(Nested(a UInt8))", "Nullable(Variant(String))", "Nullable(Nullable(String))", "Array(Nullable(Array(UInt8)))"])(
    "wrappers ClickHouse refuses: %s",
    (type) => {
      expect(typeFindings(type, "test").map((f) => f.checkId)).toEqual(["SQLCH123"]);
    },
  );
  test("view and dictionary columns are checked too", () => {
    const v = view`CREATE MATERIALIZED VIEW ${shop}.mv (kind Strng) ENGINE = MergeTree ORDER BY kind AS SELECT 'a' AS kind`;
    flagged("SQLCH121", { shop, v }, /v \(mv\): column kind Strng/);
    const d = dictionary`CREATE DICTIONARY ${shop}.d (id UInt64, name Strng) PRIMARY KEY id SOURCE(CLICKHOUSE(TABLE 't')) LAYOUT(HASHED()) LIFETIME(300)`;
    flagged("SQLCH121", { shop, d }, /column name Strng/);
  });
  test("a table with every correct type is clean for all three", () => {
    const t = events(CORRECT_TYPES.map((type, i) => `c${i} ${type}`).join(", "));
    for (const id of ["SQLCH121", "SQLCH122", "SQLCH123"]) clean(id, { shop, t });
  });
});

describe("SQLCH124: a column declared twice", () => {
  test("flags (id UInt64, id UInt32) (probe dup-column)", () => {
    flagged("SQLCH124", { shop, events: events("id UInt64, id UInt32") }, /events \(events\) declares column id twice/);
  });
  test("distinct columns are clean", () => {
    clean("SQLCH124", { shop, events: events("id UInt64, Id UInt32, n Nested(id UInt8)") });
  });
});

describe("SQLCH125: codec parameters", () => {
  test("ZSTD(99) (probe codec-bad-param)", () => {
    flagged("SQLCH125", { shop, t2: events("id UInt64 CODEC(ZSTD(99))") }, /column id CODEC\(ZSTD\(99\)\): ZSTD level 99 is outside 1 to 22/);
  });
  test.each([
    ["LZ4HC(13)", /LZ4HC level 13 is outside 0 to 12/],
    ["Delta(3), ZSTD", /Delta bytes 3 is not one of 1, 2, 4, 8/],
    ["DoubleDelta(16)", /DoubleDelta bytes 16 is not one of/],
    ["Gorilla(5)", /Gorilla bytes 5/],
    ["LZ4(1)", /LZ4 takes no parameters/],
    ["T64('nibble')", /T64 variant 'nibble' is not one of 'byte', 'bit'/],
  ])("flags %s", (codec, text) => {
    flagged("SQLCH125", { shop, t: events(`id UInt64 CODEC(${codec})`) }, text);
  });
  test("codecs within their parameters, and unknown-parameter codecs, are clean", () => {
    const t = events(
      "a UInt64 CODEC(Delta, ZSTD(3)), b UInt64 CODEC(Delta(8), LZ4HC(9)), c DateTime CODEC(DoubleDelta(4), ZSTD(1, 27)), d Float64 CODEC(Gorilla, FPC(12, 8)), e UInt64 CODEC(T64('bit'), ZSTD), f String CODEC(NONE), g String CODEC(AES_128_GCM_SIV), h Float64 CODEC(ALP(1, 2, 3))",
    );
    clean("SQLCH125", { shop, t });
  });
});

describe("SQLCH126: grant column lists", () => {
  const t = table`CREATE TABLE ${shop}.events (id UInt64, kind String, n Nested(a UInt8)) ENGINE = MergeTree ORDER BY id`;
  const r = role`CREATE ROLE analyst`;
  test("GRANT SELECT(kindd) ON ${events} (probe grant-bad-column)", () => {
    const g = grant`GRANT SELECT(kindd) ON ${t} TO ${r}`;
    flagged("SQLCH126", { shop, t, r, g }, /g: GRANT SELECT\(kindd\) ON shop.events names column kindd, which t \(events\) does not declare/);
  });
  test("declared columns, Nested fields, and a plain-text target are clean", () => {
    const g = grant`GRANT SELECT(id, kind, n.a), INSERT(id) ON ${t} TO ${r}`;
    const plain = grant`GRANT SELECT(whatever) ON shop.other TO ${r}`;
    const all = grant`GRANT SELECT ON ${t} TO ${r}`;
    clean("SQLCH126", { shop, t, r, g, plain, all });
  });
});

describe("SQLCH127: functions in expressions", () => {
  test("DEFAULT noww() (probe default-function-unknown)", () => {
    flagged("SQLCH127", { shop, events: events("id UInt64, at DateTime DEFAULT noww()") }, /events \(events\): column at DEFAULT calls noww\(\), which ClickHouse \S+ does not have/);
  });
  test("PARTITION BY toYYYYMMM(at) (probe function-unknown)", () => {
    const t = table`CREATE TABLE ${shop}.events (id UInt64, at DateTime) ENGINE = MergeTree PARTITION BY toYYYYMMM(at) ORDER BY id`;
    flagged("SQLCH127", { shop, t }, /PARTITION BY calls toYYYYMMM\(\)/);
  });
  test.each([
    ["ORDER BY", "ORDER BY (id, toStartOfHourr(at))"],
    ["PRIMARY KEY", "PRIMARY KEY lowerr(s) ORDER BY lowerr(s)"],
    ["SAMPLE BY", "ORDER BY (id, cityHash6(id)) SAMPLE BY cityHash6(id)"],
    ["TTL", "ORDER BY id TTL toDatee(at) + INTERVAL 1 DAY"],
  ])("checks %s", (where, clauses) => {
    const t = table`CREATE TABLE ${shop}.events (id UInt64, at DateTime, s String) ENGINE = MergeTree ${clauses as unknown as never}`;
    const messages = run("SQLCH127", { shop, t }).map((d) => d.message);
    expect(messages).toContainEqual(expect.stringContaining(`${where} calls`));
  });
  test("checks MATERIALIZED, ALIAS, EPHEMERAL, a column TTL and a skip index", () => {
    const t = events(
      "id UInt64, a UInt64 MATERIALIZED fooo(id), b UInt64 ALIAS barr(id), c UInt64 EPHEMERAL bazz(1), at DateTime TTL quxx(at), INDEX k zapp(id) TYPE minmax GRANULARITY 1",
    );
    const messages = run("SQLCH127", { shop, t }).map((d) => d.message);
    expect(messages).toEqual([
      expect.stringContaining("column a MATERIALIZED calls fooo()"),
      expect.stringContaining("column b ALIAS calls barr()"),
      expect.stringContaining("column c EPHEMERAL calls bazz()"),
      expect.stringContaining("column at TTL calls quxx()"),
      expect.stringContaining("index k calls zapp()"),
    ]);
  });
  test("catalog functions, aliases, combinators, keywords, lambdas, strings and func UDFs are clean", () => {
    const f = func`CREATE FUNCTION normalizeKind AS (k) -> lower(trim(k))`;
    const t = table`CREATE TABLE ${shop}.events (
      id UInt64,
      at DateTime DEFAULT now(),
      at64 DateTime64(3) DEFAULT now64(3),
      d Date DEFAULT toDate(at),
      day Date MATERIALIZED DATE_TRUNC('day', at),
      day2 Date MATERIALIZED date_trunc('day', at),
      u UUID DEFAULT generateUUIDv4(),
      s String DEFAULT 'not_a_call(x)',
      k String DEFAULT normalizeKind(s),
      c UInt64 DEFAULT CAST(1 AS UInt64),
      t Tuple(UInt8, UInt8) DEFAULT tuple(1, 2),
      i UInt8 DEFAULT if(id > 0, 1, 0),
      y UInt16 DEFAULT EXTRACT(YEAR FROM at),
      tr String DEFAULT TRIM(BOTH ' ' FROM s),
      sub String ALIAS SUBSTRING(s, 1, 2),
      dd Int64 ALIAS DATE_DIFF('day', at, now()),
      inl UInt8 ALIAS id IN (1, 2),
      arr Array(UInt64) DEFAULT arrayMap(x -> x * 2, [id]),
      cnt UInt64 ALIAS COUNT(),
      q String ALIAS \`weird(name)\`,
      m Map(String, UInt8) DEFAULT map('a', 1),
      INDEX ix lower(s) TYPE bloom_filter GRANULARITY 1
    ) ENGINE = MergeTree PARTITION BY toYYYYMM(at) ORDER BY (id, cityHash64(id)) SAMPLE BY cityHash64(id)
      TTL at + INTERVAL 1 DAY RECOMPRESS CODEC(ZSTD(17)), at + toIntervalMonth(1) DELETE`;
    clean("SQLCH127", { shop, f, t });
  });
  test("combinators resolve to their aggregate", () => {
    for (const name of ["countIf", "sumState", "uniqMerge", "argMaxIf", "sumIfState", "quantilesMergeState", "anyLastSimpleState", "sumForEach", "uniqExactOrNull", "COUNTIf"]) {
      expect(isKnownFunction(name), name).toBe(true);
    }
    for (const name of ["noww", "toYYYYMMIf", "nowState", "State", "Merge"]) expect(isKnownFunction(name), name).toBe(false);
  });
  test("only an identifier followed by ( outside strings and quoted names is a call", () => {
    expect(calledNames("f(x) + 'g(y)' + `h(z)` + t.k(1) + x IN (1) + EXISTS(1) + ARRAY(1) + INTERVAL (1) DAY")).toEqual(["f"]);
  });
});

describe("SQL101: an object declared twice", () => {
  test("two exports of shop.events (probe dup-table)", () => {
    const a = table`CREATE TABLE ${shop}.events (id UInt64) ENGINE = MergeTree ORDER BY id`;
    const b = table`CREATE TABLE ${shop}.events (id UInt64) ENGINE = MergeTree ORDER BY id`;
    const d = flagged("SQL101", { shop, a, b }, /^a and b both declare ClickHouse table shop.events/);
    expect(d.entity).toBe("b");
  });
  test("two exports of app.orders, Postgres", () => {
    const app = schema`CREATE SCHEMA app`;
    const a = pgTable`CREATE TABLE ${app}.orders (id bigint PRIMARY KEY)`;
    const b = pgTable`CREATE TABLE ${app}.orders (id bigint PRIMARY KEY)`;
    flagged("SQL101", { app, a, b }, /a and b both declare Postgres table/);
  });
  test("one name across kinds or databases, and distinct objects, are clean", () => {
    const other = database`CREATE DATABASE other ENGINE = Atomic`;
    const a = table`CREATE TABLE ${shop}.events (id UInt64) ENGINE = MergeTree ORDER BY id`;
    const b = table`CREATE TABLE ${other}.events (id UInt64) ENGINE = MergeTree ORDER BY id`;
    const r = role`CREATE ROLE analyst`;
    const g1 = grant`GRANT SELECT ON ${a} TO ${r}`;
    const g2 = grant`GRANT SELECT ON ${b} TO ${r}`;
    clean("SQL101", { shop, other, a, b, r, g1, g2 });
    const app = schema`CREATE SCHEMA app`;
    const mood = pgType`CREATE TYPE ${app}.mood AS ENUM ('a')`;
    const orders = pgTable`CREATE TABLE ${app}.orders (id bigint PRIMARY KEY)`;
    const lines = pgTable`CREATE TABLE ${app}.lines (id bigint PRIMARY KEY)`;
    clean("SQL101", { app, mood, orders, lines });
  });
});
