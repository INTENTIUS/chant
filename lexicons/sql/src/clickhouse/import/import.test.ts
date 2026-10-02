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

  test("each statement becomes one resource of its type, a bad one a warning", () => {
    const ir = new ClickHouseSqlParser().parse(`${SCHEMA}\nCREATE TABLE broken (a Strin g) ENGINE = Log;\nINSERT INTO t VALUES (1);`);
    expect(ir.resources.map((r) => [r.logicalId, r.type])).toEqual([
      ["analyticsDb", "ClickHouse::Database"],
      ["events", "ClickHouse::Table"],
      ["counts", "ClickHouse::MaterializedView"],
      ["daily", "ClickHouse::Table"],
    ]);
    expect(ir.warnings).toHaveLength(2);
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
        statement: "CREATE TABLE analytics.events\n(\n    `id` UInt64\n)\nENGINE = MergeTree\nORDER BY id\nSETTINGS index_granularity = 8192",
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

  test("verbatim keeps the statement as the server printed it", async () => {
    const ir = await run({ verbatim: true });
    expect(String(ir.resources[1]!.properties.ddl)).toContain("index_granularity = 8192");
  });

  test("a selector narrows by type and name", async () => {
    expect((await run({ selector: { name: "analytics.events" } })).resources.map((r) => r.logicalId)).toEqual(["events"]);
    expect((await run({ selector: { type: "ClickHouse::Database" } })).resources.map((r) => r.logicalId)).toEqual(["analyticsDb"]);
  });

  test("owned exports nothing and says why", async () => {
    const ir = await run({ owned: true });
    expect(ir.resources).toEqual([]);
    expect(ir.warnings?.[0]).toMatch(/ownership marker/);
  });

  test("the IR builds back through the generator", async () => {
    const ir = await run();
    expect(objectsToIR([]).resources).toEqual([]);
    expect(new ClickHouseGenerator().generate(ir)[0]!.content).toContain("CREATE TABLE ${analyticsDb}.events");
  });
});
