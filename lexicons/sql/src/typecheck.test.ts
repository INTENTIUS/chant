/**
 * Type-level guarantees of the ClickHouse dialect: the tags' return types, what
 * an entity exposes, and the name unions generated from the pinned server's
 * catalog. Each `@ts-expect-error` line must fail to compile:
 * `tsconfig.typecheck.json` (scripts/typecheck.ts in CI) fails on an unused one,
 * so a type that starts accepting what it used to reject breaks the build. The
 * invalid code sits in functions that are never called, so nothing here throws
 * at runtime.
 */
import type { AttrRef } from "@intentius/chant/attrref";
import { describe, expectTypeOf, test } from "vitest";
import {
  database,
  literal,
  table,
  view,
  type ClickHouseDatabase,
  type ClickHouseTable,
  type ClickHouseView,
  type CodecName,
  type DatabaseEngineName,
  type MergeTreeSettings,
  type SkipIndexType,
  type SqlLiteral,
  type TableEngineName,
} from "./clickhouse";

describe("the tags", () => {
  test("each returns its entity, and a table and a view expose their columns by name", () => {
    const db = database`CREATE DATABASE analytics ENGINE = Atomic`;
    const events = table`CREATE TABLE ${db}.events (user_id UUID) ENGINE = MergeTree ORDER BY user_id`;
    const recent = view`CREATE VIEW ${db}.recent AS SELECT ${events.columns.user_id} FROM ${events}`;

    expectTypeOf(db).toEqualTypeOf<ClickHouseDatabase>();
    expectTypeOf(events).toEqualTypeOf<ClickHouseTable>();
    expectTypeOf(recent).toEqualTypeOf<ClickHouseView>();
    expectTypeOf(events.columns.user_id).toEqualTypeOf<AttrRef>();
    expectTypeOf(events.entityType).toEqualTypeOf<"ClickHouse::Table">();
    expectTypeOf(db.entityType).toEqualTypeOf<"ClickHouse::Database">();
    expectTypeOf(recent.entityType).toEqualTypeOf<"ClickHouse::View" | "ClickHouse::MaterializedView">();
    expectTypeOf(events.props.columns[0]!.name).toBeString();

    const rejected = () => [
      // @ts-expect-error a tag takes a template, not a string
      table("CREATE TABLE t (a UInt8) ENGINE = Log"),
      // @ts-expect-error a database has no columns to reference
      db.columns,
      // @ts-expect-error the column record is read-only
      (events.columns.user_id = events.columns.user_id),
      // @ts-expect-error a table's props carry no SELECT; that is a view's
      events.props.select,
    ];
    void rejected;
  });

  test("literal renders a value, and only a scalar", () => {
    expectTypeOf(literal("free")).toEqualTypeOf<SqlLiteral>();
    literal(42);
    literal(null);

    const rejected = () => [
      // @ts-expect-error an object is not a scalar value
      literal({ a: 1 }),
      // @ts-expect-error undefined is not a value either
      literal(undefined),
    ];
    void rejected;
  });
});

describe("names generated from the pinned server's catalog", () => {
  test("engines, codecs and skip index types are the server's own", () => {
    const engine: TableEngineName = "ReplacingMergeTree";
    const dbEngine: DatabaseEngineName = "Atomic";
    const codec: CodecName = "ZSTD";
    const index: SkipIndexType = "bloom_filter";
    void [engine, dbEngine, codec, index];

    const rejected = () => [
      // @ts-expect-error not a ClickHouse table engine
      "InnoDB" satisfies TableEngineName,
      // @ts-expect-error a table engine is not a database engine
      "MergeTree" satisfies DatabaseEngineName,
      // @ts-expect-error not a ClickHouse codec
      "SNAPPY" satisfies CodecName,
      // @ts-expect-error not a skip index type
      "btree" satisfies SkipIndexType,
    ];
    void rejected;
  });

  test("a MergeTree setting is typed by what the server reports", () => {
    const settings: MergeTreeSettings = { index_granularity: 8192, min_bytes_for_wide_part: 0 };
    expectTypeOf(settings.index_granularity).toEqualTypeOf<number | undefined>();

    const rejected = () => [
      // @ts-expect-error a granularity is a number
      { index_granularity: "8192" } satisfies MergeTreeSettings,
      // @ts-expect-error not a MergeTree setting at the pin
      { no_such_setting: 1 } satisfies MergeTreeSettings,
    ];
    void rejected;
  });
});
