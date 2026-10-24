/**
 * Named collections referenced by name (#4395): the build records each one a
 * declaration names, a plan checks each exists by name and never reads the
 * values, and import lists the server's as prerequisites instead of refusing
 * the server.
 */

import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { makePostSynthCtx } from "@intentius/chant-test-utils";
import type { SerializerResult } from "@intentius/chant/serializer";
import { sqlSerializer } from "../serializer";
import { database, dictionary, table, view } from "./entities";
import { postSynthChecks } from "../lint/post-synth/index";
import { COLLECTION_ENGINES, COLLECTION_FUNCTIONS, createdCollectionName, functionCollections, namedCollectionReferences, sourceCollections, statementCollections } from "./named-collections";
import { checkNamedCollections, referencedCollections, renderNamedCollections } from "./live/named-collections";
import { renderDiff } from "./plan/report";
import { fakeClickHouse, type FakeServer } from "./testing/fake-server";
import { exportResources } from "./import/live-export";
import { SqlFileParser } from "../import-parser";
import { KIND_COVERAGE, kindCoverageProblems } from "../coverage";
import { CLICKHOUSE_PROBES } from "./live/undeclarable";

type Doc = { namedCollections?: string[]; objects: Array<{ export: string; namedCollections?: string[] }> };

const serialize = (entities: Record<string, unknown>) => sqlSerializer.serialize(new Map(Object.entries(entities)) as never) as SerializerResult;

const lake = table`CREATE TABLE lake (a Int32) ENGINE = S3(lake_creds, url = 'http://minio:9000/bucket/x.parquet', format = 'Parquet')`;

describe("a declaration names a collection", () => {
  test("ENGINE = S3(lake_creds, url = '...', format = 'Parquet') builds and records lake_creds", () => {
    const out = serialize({ lake });
    const doc = JSON.parse(out.primary) as Doc;
    expect(doc.namedCollections).toEqual(["lake_creds"]);
    expect(doc.objects[0]).toMatchObject({ export: "lake", namedCollections: ["lake_creds"] });
    // No post-synth check objects to it.
    const ctx = makePostSynthCtx("sql", out.primary);
    expect(postSynthChecks.flatMap((c) => c.check(ctx)).filter((d) => d.severity === "error")).toEqual([]);
  });

  test("an engine, a database engine, a table function, a view's SELECT and a dictionary SOURCE each name one", () => {
    const pg = database`CREATE DATABASE pg ENGINE = PostgreSQL(pg_creds)`;
    const kafka = table`CREATE TABLE k (a String) ENGINE = Kafka(kafka_creds, kafka_format = 'JSONEachRow')`;
    const over = table`CREATE TABLE over AS s3(\`lake creds\`, filename = 'x.parquet')`;
    const v = view`CREATE VIEW v AS SELECT * FROM mysql(mysql_creds, table = 'orders')`;
    const d = dictionary`CREATE DICTIONARY d (id UInt64, name String) PRIMARY KEY id SOURCE(MYSQL(NAME mysql_creds TABLE 'names')) LAYOUT(HASHED()) LIFETIME(300)`;
    const doc = JSON.parse(serialize({ pg, kafka, over, v, d }).primary) as Doc;
    expect(doc.namedCollections).toEqual(["kafka_creds", "lake creds", "mysql_creds", "pg_creds"]);
    expect(Object.fromEntries(doc.objects.map((o) => [o.export, o.namedCollections]))).toEqual({
      pg: ["pg_creds"],
      kafka: ["kafka_creds"],
      over: ["lake creds"],
      v: ["mysql_creds"],
      d: ["mysql_creds"],
    });
  });

  test("a build that names none records nothing", () => {
    const t = table`CREATE TABLE t (a Int32) ENGINE = S3('http://minio:9000/bucket/x.parquet', 'Parquet')`;
    const plain = table`CREATE TABLE p (a Int32) ENGINE = MergeTree ORDER BY a`;
    const doc = JSON.parse(serialize({ t, plain }).primary) as Doc;
    expect(doc.namedCollections).toBeUndefined();
    expect(doc.objects.map((o) => o.namedCollections)).toEqual([undefined, undefined]);
  });

  test("a first argument that is a string, NOSIGN, a cluster or a column is not a collection", () => {
    expect(namedCollectionReferences({ engine: { name: "S3", args: ["NOSIGN"] } })).toEqual([]);
    expect(namedCollectionReferences({ engine: { name: "Distributed", args: ["main", "db", "t"] } })).toEqual([]);
    expect(namedCollectionReferences({ engine: { name: "ReplacingMergeTree", args: ["ver"] } })).toEqual([]);
    expect(functionCollections("SELECT * FROM s3Cluster(main, 'http://x/y', 'CSV')")).toEqual([]);
    expect(functionCollections("SELECT * FROM remote('h:9000', db, t)")).toEqual([]);
    expect(functionCollections("SELECT x.s3(a) FROM t")).toEqual([]);
  });

  test("the engines and table functions listed are ones the pinned server has", () => {
    for (const e of ["S3", "Kafka", "MySQL", "PostgreSQL", "MongoDB", "AzureBlobStorage", "RabbitMQ", "NATS"]) expect(COLLECTION_ENGINES, e).toContain(e);
    for (const f of ["s3", "mysql", "postgresql", "url", "remote", "azureblobstorage"]) expect(COLLECTION_FUNCTIONS, f).toContain(f);
    expect([...COLLECTION_FUNCTIONS].some((f) => f.endsWith("cluster"))).toBe(false);
  });

  test("a statement as the server prints it", () => {
    expect(statementCollections("CREATE TABLE analytics.lake\n(\n    `a` Int32\n)\nENGINE = S3(lake_creds, url = 'http://x/y', format = 'Parquet')")).toEqual(["lake_creds"]);
    expect(statementCollections("CREATE DICTIONARY d (`id` UInt64, `name` String) PRIMARY KEY id SOURCE(MYSQL(NAME 'mysql_creds')) LAYOUT(HASHED()) LIFETIME(300)")).toEqual(["mysql_creds"]);
    // A column called name is not a source's NAME.
    expect(statementCollections("CREATE TABLE t (`name` String) ENGINE = MergeTree ORDER BY name")).toEqual([]);
    expect(sourceCollections("CLICKHOUSE(TABLE 'rates')")).toEqual([]);
    expect(createdCollectionName("CREATE NAMED COLLECTION IF NOT EXISTS `lake creds` AS url = 'x'")).toBe("lake creds");
  });
});

describe("a plan checks each exists, by name", () => {
  let server: FakeServer;
  beforeAll(async () => {
    server = await fakeClickHouse([], {});
  });
  afterAll(() => server.close());

  test("the build output's list is what is checked", () => {
    expect(referencedCollections(serialize({ lake }).primary)).toEqual(["lake_creds"]);
  });

  test("it reads names only, never a collection's values", async () => {
    await checkNamedCollections({ url: server.url }, ["lake_creds", "kafka_creds"]);
    const sent = server.queries.filter((q) => q.includes("named_collections"));
    expect(sent).toEqual(["/* chant plan: named collections */ SELECT name FROM system.named_collections WHERE name IN ('kafka_creds', 'lake_creds')"]);
  });

  test("one the server does not have fails the plan, naming it", () => {
    const check = { referenced: ["kafka_creds", "lake_creds"], missing: ["lake_creds"] };
    const text = renderDiff({ changes: [], rebuilds: [], hints: [], namedCollections: check });
    expect(text).toContain("No changes.");
    expect(text).toMatch(/Refused: the build references a named collection the server does not have: lake_creds\./);
    expect(renderNamedCollections({ referenced: ["lake_creds"], missing: [] })).toEqual([]);
  });

  test("a server whose collections cannot be read fails the plan too", async () => {
    const failing = await fakeClickHouse([], { fail: { status: 500, body: "Code: 497. DB::Exception: Not enough privileges. (ACCESS_DENIED)" } });
    try {
      const check = await checkNamedCollections({ url: failing.url }, ["lake_creds"]);
      expect(check).toMatchObject({ referenced: ["lake_creds"], missing: ["lake_creds"], unread: expect.stringMatching(/ACCESS_DENIED/) });
      expect(renderNamedCollections(check).join("\n")).toMatch(/could not be read to check them/);
    } finally {
      await failing.close();
    }
  });
});

describe("import lists the server's as prerequisites", () => {
  let server: FakeServer;
  beforeAll(async () => {
    server = await fakeClickHouse(
      [
        { name: "analytics", engine: "Atomic", statement: "CREATE DATABASE analytics\nENGINE = Atomic" },
        {
          database: "analytics",
          name: "lake",
          engine: "S3",
          statement: "CREATE TABLE analytics.lake\n(\n    `a` Int32\n)\nENGINE = S3(lake_creds, url = 'http://minio:9000/bucket/x.parquet', format = 'Parquet')",
        },
      ],
      { undeclarable: [{ kind: "named collection", name: "lake_creds" }, { kind: "named collection", name: "spare" }] },
    );
  });
  afterAll(() => server.close());

  test("a server with SQL-defined named collections imports, and lists each with what names it", async () => {
    const ir = await exportResources({ environment: "prod", config: {}, env: { CLICKHOUSE_URL: server.url } });
    expect(ir.resources.map((r) => r.properties.name)).toEqual(["analytics", "lake"]);
    expect(ir.metadata?.prerequisites).toEqual([
      { kind: "named collection", name: "lake_creds", referencedBy: ["analytics.lake"] },
      { kind: "named collection", name: "spare", referencedBy: [] },
    ]);
    const warnings = (ir.warnings ?? []).filter((w) => w.startsWith("named collection"));
    expect(warnings).toEqual([
      expect.stringMatching(/^named collection lake_creds is a prerequisite of prod, named by analytics\.lake: the server holds it, and chant does not declare it or read its values/),
      expect.stringMatching(/^named collection spare is a prerequisite of prod: the server holds it/),
    ]);
    // Names only: no query reads a collection's keys, values or create query.
    const reads = server.queries.filter((q) => q.includes("named_collections"));
    expect(reads).toHaveLength(1);
    expect(reads[0]).toMatch(/SELECT database, name FROM \(SELECT '' AS database, name FROM system\.named_collections WHERE source = 'SQL'\)/);
  });

  test("a .sql file's CREATE NAMED COLLECTION is a prerequisite, not a refusal", () => {
    const ir = new SqlFileParser("clickhouse").parse(
      "CREATE DATABASE a;\nCREATE NAMED COLLECTION lake_creds AS url = 'x', secret_access_key = 'y';\nCREATE TABLE a.t (x Int32) ENGINE = S3(lake_creds, format = 'Parquet')",
    );
    expect(ir.resources.map((r) => r.type)).toEqual(["ClickHouse::Database", "ClickHouse::Table"]);
    expect(ir.metadata?.prerequisites).toEqual([{ kind: "named collection", name: "lake_creds", referencedBy: ["a.t"] }]);
    expect(ir.warnings).toEqual([expect.stringMatching(/^named collection lake_creds is a prerequisite, named by a\.t: the DDL creates it, and chant does not declare it/)]);
    // Its values are not carried anywhere.
    expect(JSON.stringify(ir)).not.toContain("secret_access_key");
  });
});

describe("the coverage table's referenced status", () => {
  test("a named collection is referenced, with a reason and a live query", () => {
    const row = KIND_COVERAGE.clickhouse.find((r) => r.kind === "named collection");
    expect(row).toMatchObject({ status: "referenced" });
    expect(row?.reason).toMatch(/never declares one or reads its values/);
    expect(Object.keys(CLICKHOUSE_PROBES)).toContain("named collection");
  });

  test("a referenced row needs a reason, as a refused one does", () => {
    const rows = [{ command: "CREATE NAMED COLLECTION", kind: "named collection", status: "referenced" as const }];
    expect(kindCoverageProblems("clickhouse", { pins: [{ version: "x", commands: ["CREATE NAMED COLLECTION"] }], rows })).toEqual(["named collection is referenced, and gives no reason"]);
  });
});
