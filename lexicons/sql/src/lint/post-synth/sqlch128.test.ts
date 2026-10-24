/**
 * SQLCH128 (#4395): a literal credential in an integration engine's or table
 * function's arguments. Each flagged case builds today and writes its secret
 * into the build output and `clickhouse.sql`; each clean case keeps it out.
 */
import { describe, expect, test } from "vitest";
import { makePostSynthCtx } from "@intentius/chant-test-utils";
import type { SerializerResult } from "@intentius/chant/serializer";
import { sqlSerializer } from "../../serializer";
import { database, dictionary, table, view } from "../../clickhouse/entities";
import { sqlAuditCatalog } from "../audit-catalog";
import { postSynthChecks } from "./index";

function run(entities: Record<string, unknown>) {
  const check = postSynthChecks.find((c) => c.id === "SQLCH128")!;
  const out = sqlSerializer.serialize(new Map(Object.entries(entities)) as never) as SerializerResult;
  return check.check(makePostSynthCtx("sql", out.primary));
}

/** The findings' messages, in the build's apply order (by export name here). */
const messages = (entities: Record<string, unknown>) => {
  const diags = run(entities);
  for (const d of diags) expect(d).toMatchObject({ checkId: "SQLCH128", lexicon: "sql", severity: "error" });
  return diags.map((d) => d.message);
};

test("SQLCH128 is registered with an audit entry", () => {
  expect(postSynthChecks.map((c) => c.id)).toContain("SQLCH128");
  expect(sqlAuditCatalog.SQLCH128).toBeDefined();
});

describe("an inline secret fails", () => {
  test("S3: the secret access key", () => {
    const t = table`CREATE TABLE lake (a Int32) ENGINE = S3('https://bucket.s3.amazonaws.com/x.parquet', 'AKIAEXAMPLE', 'wJalrXUtnFEMI', 'Parquet')`;
    expect(messages({ t })).toEqual([
      expect.stringMatching(
        /^t \(lake\): ENGINE = S3 argument secret_access_key holds a literal credential, which is the environment's\. Create a named collection .*ENGINE = S3\(lake_creds, format = 'Parquet'\)/,
      ),
    ]);
  });

  test("Kafka: kafka_sasl_password, a setting", () => {
    const t = table`CREATE TABLE k (a String) ENGINE = Kafka() SETTINGS kafka_broker_list = 'kafka:9092', kafka_topic_list = 'events', kafka_group_name = 'g', kafka_format = 'JSONEachRow', kafka_sasl_username = 'app', kafka_sasl_password = 'hunter2'`;
    expect(messages({ t })).toEqual([expect.stringMatching(/^t \(k\): Kafka setting kafka_sasl_password holds a literal credential/)]);
  });

  test("PostgreSQL and MySQL: the password", () => {
    const pg = table`CREATE TABLE pg (id Int32) ENGINE = PostgreSQL('db:5432', 'shop', 'orders', 'app', 'hunter2')`;
    const my = table`CREATE TABLE my (id Int32) ENGINE = MySQL('db:3306', 'shop', 'orders', 'app', 'hunter2')`;
    expect(messages({ pg, my })).toEqual([
      expect.stringMatching(/^my \(my\): ENGINE = MySQL argument password holds a literal credential/),
      expect.stringMatching(/^pg \(pg\): ENGINE = PostgreSQL argument password holds a literal credential/),
    ]);
  });

  test("a database engine, a key = value override after a collection, a URL with a password", () => {
    const db = database`CREATE DATABASE mirror ENGINE = MySQL('db:3306', 'shop', 'app', 'hunter2')`;
    const s3 = table`CREATE TABLE s (a Int32) ENGINE = S3(lake_creds, secret_access_key = 'override', format = 'Parquet')`;
    const u = table`CREATE TABLE u (a Int32) ENGINE = URL('https://app:hunter2@example.com/data.csv', 'CSV')`;
    expect(messages({ db, s3, u })).toEqual([
      expect.stringMatching(/^db \(mirror\): ENGINE = MySQL argument password holds a literal credential/),
      expect.stringMatching(/^s3 \(s\): ENGINE = S3 argument secret_access_key holds a literal credential/),
      expect.stringMatching(/^u \(u\): ENGINE = URL argument 1 holds a URL with a password in it/),
    ]);
  });

  test("a table function, in a table over it and in a view's SELECT", () => {
    const over = table`CREATE TABLE over AS s3('https://bucket/x.csv', 'AKIAEXAMPLE', 'wJalrXUtnFEMI', 'CSV')`;
    const v = view`CREATE VIEW v AS SELECT * FROM mysql('db:3306', 'shop', 'orders', 'app', 'hunter2')`;
    const r = view`CREATE VIEW r AS SELECT * FROM remote('h:9000', 'shop', 'orders', 'app', 'hunter2')`;
    expect(messages({ over, v, r })).toEqual([
      expect.stringMatching(/^over \(over\): s3\(\) argument secret_access_key holds a literal credential/),
      expect.stringMatching(/^r \(r\): remote\(\) argument password holds a literal credential/),
      expect.stringMatching(/^v \(v\): mysql\(\) argument password holds a literal credential/),
    ]);
  });

  test("a dictionary source's PASSWORD", () => {
    const d = dictionary`CREATE DICTIONARY d (id UInt64, name String) PRIMARY KEY id SOURCE(MYSQL(HOST 'db' PORT 3306 USER 'app' PASSWORD 'hunter2' DB 'shop' TABLE 'names')) LAYOUT(HASHED()) LIFETIME(300)`;
    expect(messages({ d })).toEqual([expect.stringMatching(/^d \(d\): SOURCE PASSWORD holds a literal credential/)]);
  });

  test("the server's '[HIDDEN]' mask, as an import of SHOW CREATE writes it, is named as such", () => {
    const t = table`CREATE TABLE lake (a Int32) ENGINE = S3('https://bucket/x.parquet', 'AKIAEXAMPLE', '[HIDDEN]')`;
    expect(messages({ t })).toEqual([expect.stringMatching(/secret_access_key holds '\[HIDDEN\]', the server's mask for a credential, in place of one/)]);
  });
});

describe("no secret, no finding", () => {
  test("a named collection in place of the arguments", () => {
    const s3 = table`CREATE TABLE lake (a Int32) ENGINE = S3(lake_creds, url = 'https://bucket/x.parquet', format = 'Parquet')`;
    const k = table`CREATE TABLE k (a String) ENGINE = Kafka(kafka_creds, kafka_format = 'JSONEachRow')`;
    const pg = table`CREATE TABLE pg (id Int32) ENGINE = PostgreSQL(pg_creds, table = 'orders')`;
    const v = view`CREATE VIEW v AS SELECT * FROM mysql(mysql_creds, table = 'orders')`;
    const d = dictionary`CREATE DICTIONARY d (id UInt64, name String) PRIMARY KEY id SOURCE(MYSQL(NAME mysql_creds)) LAYOUT(HASHED()) LIFETIME(300)`;
    expect(messages({ s3, k, pg, v, d })).toEqual([]);
  });

  test("an S3 table with a format and a compression where the keys would be, NOSIGN, or an empty password", () => {
    const fmt = table`CREATE TABLE f (a Int32) ENGINE = S3('https://bucket/x.csv.gz', 'CSV', 'gzip')`;
    const nosign = table`CREATE TABLE n (a Int32) ENGINE = S3('https://bucket/x.csv', NOSIGN, 'CSV')`;
    const az = table`CREATE TABLE az (a Int32) ENGINE = AzureBlobStorage('https://acct.blob.core.windows.net', 'c', 'p.csv', 'CSV', 'gzip')`;
    const d = dictionary`CREATE DICTIONARY d (id UInt64, name String) PRIMARY KEY id SOURCE(CLICKHOUSE(TABLE 'names' USER 'default' PASSWORD '')) LAYOUT(HASHED()) LIFETIME(300)`;
    const mt = table`CREATE TABLE m (password String) ENGINE = MergeTree ORDER BY tuple()`;
    expect(messages({ fmt, nosign, az, d, mt })).toEqual([]);
  });
});
