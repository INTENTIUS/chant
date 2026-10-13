import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { ClickHouseSqlParser } from "./parser";
import { ClickHouseGenerator } from "./generator";
import { exportNames, objectsToIR, splitStatements, stripServerDefaults } from "./ir";
import { exportResources } from "./live-export";
import { fakeClickHouse, type FakeServer } from "../testing/fake-server";

const SCHEMA = `
CREATE DATABASE analytics ENGINE = Atomic;

CREATE TABLE analytics.events
(
    \`user_id\` UUID,
    \`kind\` LowCardinality(String),
    \`my col\` String DEFAULT 'a\`b'
)
ENGINE = MergeTree
ORDER BY (user_id, kind)
SETTINGS index_granularity = 8192;

CREATE MATERIALIZED VIEW analytics.counts TO analytics.daily
(
    \`kind\` LowCardinality(String),
    \`n\` UInt64
)
AS SELECT kind, count() AS n
FROM analytics.events
GROUP BY kind;

CREATE TABLE analytics.daily (kind LowCardinality(String), n UInt64) ENGINE = SummingMergeTree ORDER BY kind;
`;

describe("reading a file of statements", () => {
  test("splits on top-level semicolons only", () => {
    expect(splitStatements("CREATE TABLE a (s String DEFAULT ';') ENGINE = Log; ; CREATE DATABASE b")).toEqual([
      "CREATE TABLE a (s String DEFAULT ';') ENGINE = Log",
      "CREATE DATABASE b",
    ]);
  });

  test("each statement becomes one resource of its type", () => {
    const ir = new ClickHouseSqlParser().parse(SCHEMA);
    expect(ir.resources.map((r) => [r.logicalId, r.type])).toEqual([
      ["analyticsDb", "ClickHouse::Database"],
      ["events", "ClickHouse::Table"],
      ["counts", "ClickHouse::MaterializedView"],
      ["daily", "ClickHouse::Table"],
    ]);
  });

  test("a statement that does not parse or is not a CREATE stops the import, each named", () => {
    const parse = () => new ClickHouseSqlParser().parse(`${SCHEMA}\nCREATE TABLE broken (a Strin g) ENGINE = Log;\nINSERT INTO t VALUES (1);`);
    expect(parse).toThrow(/2 statements chant cannot read as declarations/);
    expect(parse).toThrow(/does not parse \(.*\): CREATE TABLE broken/);
    expect(parse).toThrow(/not a CREATE statement: INSERT INTO t VALUES \(1\)/);
  });
});

describe("export names", () => {
  test("a database is suffixed Db, a shared table name takes its database, a reserved word is avoided", () => {
    expect(
      exportNames([
        { type: "ClickHouse::Database", name: "default", ddl: "" },
        { type: "ClickHouse::Table", database: "a", name: "events", ddl: "" },
        { type: "ClickHouse::Table", database: "b", name: "events", ddl: "" },
        { type: "ClickHouse::Table", database: "a", name: "class", ddl: "" },
        { type: "ClickHouse::Table", database: "a", name: "00_raw", ddl: "" },
      ]),
    ).toEqual(["defaultDb", "aEvents", "bEvents", "classTable", "t00Raw"]);
  });
});

describe("what the server adds is left out by default", () => {
  test("a setting at its default goes, another stays", () => {
    const out = stripServerDefaults(
      "CREATE TABLE t\n(\n    `a` UInt8\n)\nENGINE = MergeTree\nORDER BY a\nSETTINGS index_granularity = 8192, min_bytes_for_wide_part = 0",
    );
    expect(out).toContain("SETTINGS min_bytes_for_wide_part = 0");
    expect(out).not.toContain("index_granularity");
  });

  test("a view's inferred column list goes", () => {
    const out = stripServerDefaults("CREATE VIEW v\n(\n    `id` UInt64\n)\nAS SELECT id\nFROM t");
    expect(out).toBe("CREATE VIEW v\nAS SELECT id\nFROM t");
  });
});

describe("generating declarations", () => {
  const ir = new ClickHouseSqlParser().parse(SCHEMA);
  const [file] = new ClickHouseGenerator().generate(ir);

  test("one schema.ts, references interpolated, each declaration after what it references", () => {
    expect(file!.path).toBe("schema.ts");
    const src = file!.content;
    expect(src).toContain('import { database, table, view } from "@intentius/chant-lexicon-sql/clickhouse";');
    expect(src).toContain("CREATE TABLE ${analyticsDb}.events");
    expect(src).toContain("TO ${daily}");
    expect(src).toContain("FROM ${events}");
    const order = [...src.matchAll(/export const (\w+)/g)].map((m) => m[1]);
    expect(order).toEqual(["analyticsDb", "events", "daily", "counts"]);
  });

  test("identifiers lose their backquotes, and one that needs quoting is double-quoted", () => {
    expect(file!.content).toContain("user_id UUID");
    expect(file!.content).toContain('"my col" String');
    expect(file!.content).toContain("DEFAULT 'a\\`b'");
  });
});

describe("live export", () => {
  let server: FakeServer;
  beforeAll(async () => {
    server = await fakeClickHouse([
      { name: "default", engine: "Atomic", statement: "CREATE DATABASE default\nENGINE = Atomic" },
      { name: "analytics", engine: "Atomic", statement: "CREATE DATABASE analytics\nENGINE = Atomic" },
      {
        database: "analytics",
        name: "events",
        engine: "MergeTree",
        statement:
          "CREATE TABLE analytics.events\n(\n    `id` UInt64\n)\nENGINE = MergeTree\nORDER BY id\nSETTINGS index_granularity = 8192\nCOMMENT 'Raw events [chant managed-by=chant stack=shop]'",
        comment: "Raw events [chant managed-by=chant stack=shop]",
      },
      {
        database: "analytics",
        name: "schema_migrations",
        engine: "MergeTree",
        statement: "CREATE TABLE analytics.schema_migrations\n(\n    `version` Int64,\n    `dirty` UInt8,\n    `sequence` UInt64\n)\nENGINE = MergeTree\nORDER BY sequence",
      },
    ]);
  });
  afterAll(() => server.close());

  const run = (extra: Record<string, unknown> = {}) =>
    exportResources({ environment: "x", config: {}, env: { CLICKHOUSE_URL: server.url }, ...extra });

  test("exports every object but the default database, defaults stripped", async () => {
    const ir = await run();
    expect(ir.resources.map((r) => r.logicalId)).toEqual(["analyticsDb", "events"]);
    expect(String(ir.resources[1]!.properties.ddl)).not.toContain("index_granularity");
  });

  test("a migration runner's history table is left out with a warning (#3676)", async () => {
    const ir = await run();
    expect(ir.resources.map((r) => r.properties.name)).not.toContain("schema_migrations");
    expect(ir.warnings).toEqual([
      "analytics.schema_migrations is kept by a migration runner (Rails, golang-migrate, dbmate); left out, since declaring it would have chant change what that tool owns",
    ]);
  });

  test("verbatim keeps the statement as the server printed it", async () => {
    const ir = await run({ verbatim: true });
    expect(String(ir.resources[1]!.properties.ddl)).toContain("index_granularity = 8192");
  });

  test("a selector narrows by type and name", async () => {
    expect((await run({ selector: { name: "analytics.events" } })).resources.map((r) => r.logicalId)).toEqual(["events"]);
    expect((await run({ selector: { type: "ClickHouse::Database" } })).resources.map((r) => r.logicalId)).toEqual(["analyticsDb"]);
  });

  test("owned keeps the objects carrying chant's marker (#3208)", async () => {
    const ir = await run({ owned: true });
    expect(ir.resources.map((r) => r.logicalId)).toEqual(["events"]);
  });

  test("the ownership marker is never written into a declaration (#3208)", async () => {
    const ddl = String((await run()).resources[1]!.properties.ddl);
    expect(ddl).toContain("COMMENT 'Raw events'");
    expect(ddl).not.toContain("[chant");
  });

  test("the IR builds back through the generator", async () => {
    const ir = await run();
    expect(objectsToIR([]).resources).toEqual([]);
    expect(new ClickHouseGenerator().generate(ir)[0]!.content).toContain("CREATE TABLE ${analyticsDb}.events");
  });
});

describe("live export of SQL functions (#3718)", () => {
  let server: FakeServer;
  beforeAll(async () => {
    server = await fakeClickHouse(
      [
        { name: "shop", engine: "Atomic", statement: "CREATE DATABASE shop\nENGINE = Atomic" },
        {
          database: "shop",
          name: "orders",
          engine: "MergeTree",
          statement: "CREATE TABLE shop.orders\n(\n    `id` UInt64,\n    `net` Float64 DEFAULT shop_net(id)\n)\nENGINE = MergeTree\nORDER BY id",
        },
        {
          // ClickHouse stores a call as the function's body (#3745): this is shop_gross(net).
          database: "shop",
          name: "gross",
          engine: "View",
          statement: "CREATE VIEW shop.gross\n(\n    `g` Float64\n)\nAS SELECT net + (net * 0.07) AS g\nFROM shop.orders",
        },
      ],
      {
        functions: [
          { name: "other_score", statement: "CREATE FUNCTION other_score AS x -> (x * 2)" },
          { name: "shop_gross", statement: "CREATE FUNCTION shop_gross AS x -> (x + (x * 0.07))" },
          { name: "shop_net", statement: "CREATE FUNCTION shop_net AS x -> shop_tax(x)" },
          { name: "shop_tax", statement: "CREATE FUNCTION shop_tax AS x -> (x * 0.2)" },
          { name: "shop_unused", statement: "CREATE FUNCTION shop_unused AS x -> x" },
        ],
      },
    );
  });
  afterAll(() => server.close());

  const run = (profile: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) =>
    exportResources({ environment: "x", config: { sql: { profiles: { x: { url: server.url, ...profile } } } } as never, env: {}, ...extra });

  test("adopts the functions the imported objects call, and the ones those call; a warning names the rest", async () => {
    const ir = await run();
    expect(ir.resources.map((r) => r.properties.name)).toEqual(["shop", "orders", "gross", "shop_gross", "shop_net", "shop_tax"]);
    expect(ir.warnings).toEqual([
      "2 SQL functions on the server are not imported, since no imported object uses them: other_score, shop_unused. Name them in sql.profiles.x.importFunctions to import them.",
    ]);
  });

  test("importFunctions names more, by name or by prefix", async () => {
    expect((await run({ importFunctions: ["shop_*"] })).resources.map((r) => r.properties.name)).toEqual(["shop", "orders", "gross", "shop_gross", "shop_net", "shop_tax", "shop_unused"]);
    const ir = await run({ importFunctions: ["other_score"] });
    expect(ir.resources.map((r) => r.properties.name)).toContain("other_score");
    expect(ir.warnings).toEqual([expect.stringContaining(": shop_unused.")]);
  });

  test("a selector picks a function it names", async () => {
    const ir = await run({}, { selector: { name: "other_score" } });
    expect(ir.resources.map((r) => r.properties.name)).toEqual(["other_score"]);
    expect(ir.warnings).toBeUndefined();
  });
});
