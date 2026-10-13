import { describe, expect, test } from "vitest";
import { makePostSynthCtx } from "@intentius/chant-test-utils";
import type { PostSynthCheck, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
import type { SerializerResult } from "@intentius/chant/serializer";
import { sqlSerializer } from "./serializer";
import { database, table as chTable, view as chView } from "./clickhouse/entities";
import { index, schema, table, view } from "./postgres/entities";
import { canonicalPostgresType, readClickHouse, readPostgres, readSql } from "./read";
import { readPostgres as fromPostgresSubpath } from "./postgres";
import { readClickHouse as fromClickHouseSubpath } from "./clickhouse";
import { tablesOf as pgTablesOf } from "./lint/post-synth/postgres-helpers";
import { tablesOf as chTablesOf } from "./lint/post-synth/clickhouse-helpers";

const ctxOf = (entities: Record<string, unknown>) => {
  const out = sqlSerializer.serialize(new Map(Object.entries(entities)) as never) as SerializerResult;
  return makePostSynthCtx("sql", out.primary);
};

describe("readPostgres (#3870)", () => {
  const app = schema`CREATE SCHEMA app`;
  const users = table`
    CREATE TABLE ${app}.users (
      id bigserial PRIMARY KEY,
      email text NOT NULL UNIQUE,
      nickname varchar(40) DEFAULT 'anon',
      tags text[],
      created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
    )`;
  const orders = table`
    CREATE TABLE ${app}.orders (
      id bigint GENERATED ALWAYS AS IDENTITY,
      user_id bigint NOT NULL REFERENCES ${users} (id),
      created_at timestamp,
      PRIMARY KEY (id)
    )`;
  const ordersUser = index`CREATE INDEX orders_user_id ON ${orders} (user_id, (lower('x')))`;
  const totals = view`CREATE VIEW ${app}.totals AS SELECT user_id, count(*) AS n FROM ${orders} GROUP BY user_id`;
  const ctx = ctxOf({ app, users, orders, ordersUser, totals });

  test("tables carry typed columns: canonical type, nullability, default, keys", () => {
    const db = readPostgres(ctx);
    expect(db.dialect).toBe("postgres");
    expect(db.tables.map((t) => t.qualifiedName).sort()).toEqual(["app.orders", "app.users"]);
    const u = db.table("users")!;
    expect(u.column("id")).toMatchObject({ typeName: "bigint", nullable: false, inPrimaryKey: true });
    expect(u.column("email")).toMatchObject({ typeName: "text", nullable: false, inPrimaryKey: false });
    expect(u.column("nickname")).toMatchObject({ typeName: "character varying", nullable: true, default: "'anon'" });
    expect(u.column("tags")).toMatchObject({ typeName: "text", array: true });
    expect(u.column("created_at")).toMatchObject({ typeName: "timestamp with time zone", nullable: false, default: "now()" });
    expect(u.uniques[0]!.columns).toEqual(["email"]);
    expect(db.table("app.orders")!.column("id")).toMatchObject({ nullable: false, inPrimaryKey: true });
    expect(db.table("orders")!.column("created_at")).toMatchObject({ typeName: "timestamp without time zone", nullable: true });
    expect(db.table("orders")!.foreignKeys[0]).toMatchObject({ columns: ["user_id"], references: "users" });
  });

  test("indexes belong to their table and lead with their bare columns", () => {
    const db = readPostgres(ctx);
    expect(db.indexes).toHaveLength(1);
    expect(db.indexes[0]).toMatchObject({ export: "ordersUser", table: "orders", columns: ["user_id"] });
    expect(db.table("orders")!.indexes.map((i) => i.export)).toEqual(["ordersUser"]);
  });

  test("views name their outputs and keep their lineage", () => {
    const v = readPostgres(ctx).views[0]!;
    expect(v).toMatchObject({ qualifiedName: "app.totals", materialized: false, outputs: ["user_id", "n"] });
    expect(v.lineage.map((e) => e.output)).toEqual(["user_id", "n"]);
  });

  test("canonicalPostgresType spells aliases the way typeName does", () => {
    expect(canonicalPostgresType("timestamptz")).toBe("timestamp with time zone");
    expect(canonicalPostgresType("INT4")).toBe("integer");
    expect(canonicalPostgresType("varchar(10)")).toBe("character varying");
  });

  test("the checks read the same values, and the dialect subpath exports the same reader", () => {
    expect(pgTablesOf(ctx)).toBe(readPostgres(ctx).tables);
    expect(fromPostgresSubpath).toBe(readPostgres);
    expect(readClickHouse(ctx).tables).toEqual([]);
    expect(readSql(ctx)?.dialect).toBe("postgres");
  });

  test("reads a serialized document as well as a context", () => {
    const doc = JSON.parse((sqlSerializer.serialize(new Map(Object.entries({ app, users })) as never) as SerializerResult).primary) as { dialect: string; objects: unknown[] };
    expect(readPostgres(doc).table("users")!.column("email")!.nullable).toBe(false);
    expect(readSql(doc as never)?.dialect).toBe("postgres");
  });

  test("a project policy written against the read API flags a table without created_at timestamptz NOT NULL", () => {
    const TIMESTAMPTZ = canonicalPostgresType("timestamptz");
    const policy: PostSynthCheck = {
      id: "ORG-CREATED-AT",
      description: "every table has created_at timestamptz NOT NULL",
      check(c): PostSynthDiagnostic[] {
        return readPostgres(c)
          .tables.filter((t) => {
            const col = t.column("created_at");
            return !col || col.typeName !== TIMESTAMPTZ || col.nullable;
          })
          .map((t) => ({ checkId: "ORG-CREATED-AT", severity: "error", entity: t.export, message: `${t.qualifiedName} needs created_at timestamptz NOT NULL` }));
      },
    };
    expect(policy.check(ctx).map((d) => d.entity)).toEqual(["orders"]);
  });
});

describe("readClickHouse (#3870)", () => {
  const shop = database`CREATE DATABASE shop ENGINE = Atomic`;
  const events = chTable`
    CREATE TABLE ${shop}.events (
      ts DateTime64(3) CODEC(Delta, ZSTD),
      kind LowCardinality(String),
      user_id UInt64,
      ref Nullable(String) COMMENT 'referrer',
      label LowCardinality(Nullable(String)) DEFAULT 'x',
      INDEX kind_idx kind TYPE set(100) GRANULARITY 4
    )
    ENGINE = ReplicatedReplacingMergeTree('/ch/{shard}/events', '{replica}', ts)
    ORDER BY (kind, toDate(ts), user_id)`;
  const daily = chView`CREATE VIEW ${shop}.daily AS SELECT toDate(ts) AS day, count() AS n FROM ${events} GROUP BY day`;
  const ctx = ctxOf({ shop, events, daily });

  test("tables carry typed columns, the engine family and the keys", () => {
    const db = readClickHouse(ctx);
    const t = db.table("shop.events")!;
    expect(t).toMatchObject({ qualifiedName: "shop.events", engineFamily: "ReplacingMergeTree", mergeTree: true });
    expect(t.sortKey).toEqual(["kind", "toDate(ts)", "user_id"]);
    expect(t.primaryKeyElements).toEqual(t.sortKey);
    expect(t.column("ts")).toMatchObject({ family: "DateTime64", nullable: false, inSortKey: false, codec: "Delta, ZSTD" });
    expect(t.column("kind")).toMatchObject({ lowCardinality: true, baseType: "String", nullable: false, inSortKey: true });
    expect(t.column("ref")).toMatchObject({ nullable: true, comment: "referrer" });
    expect(t.column("label")).toMatchObject({ nullable: true, lowCardinality: true, default: { kind: "DEFAULT", expr: "'x'" } });
    expect(t.indexes[0]).toMatchObject({ name: "kind_idx", type: "set(100)" });
  });

  test("views name their outputs; the checks and the subpath share the reader", () => {
    const v = readClickHouse(ctx).views[0]!;
    expect(v).toMatchObject({ materialized: false, outputs: ["day", "n"] });
    expect(chTablesOf(ctx)).toBe(readClickHouse(ctx).tables);
    expect(fromClickHouseSubpath).toBe(readClickHouse);
    expect(readSql(ctx)?.dialect).toBe("clickhouse");
    expect(readPostgres(ctx).tables).toEqual([]);
  });
});
