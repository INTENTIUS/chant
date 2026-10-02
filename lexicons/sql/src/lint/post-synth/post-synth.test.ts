import { describe, expect, test } from "vitest";
import { makePostSynthCtx } from "@intentius/chant-test-utils";
import type { SerializerResult } from "@intentius/chant/serializer";
import { sqlSerializer } from "../../serializer";
import { database, table } from "../../clickhouse/entities";
import { sqlch101 } from "./sqlch101";

function ctxFor(entities: Array<[string, unknown]>) {
  const out = sqlSerializer.serialize(new Map(entities as never)) as SerializerResult;
  return makePostSynthCtx("sql", out.primary);
}

describe("SQLCH101: an engine the pinned server does not have", () => {
  test("a misspelled table engine is reported against the object", () => {
    const t = table`CREATE TABLE t (a UInt8) ENGINE = MergTree ORDER BY a`;
    const diags = sqlch101.check(ctxFor([["t", t]]));
    expect(diags).toHaveLength(1);
    expect(diags[0]).toMatchObject({ checkId: "SQLCH101", severity: "error", entity: "t" });
    expect(diags[0]!.message).toMatch(/"MergTree"/);
  });

  test("a database engine is checked against the database engines", () => {
    const db = database`CREATE DATABASE d ENGINE = MergeTree`;
    expect(sqlch101.check(ctxFor([["d", db]]))).toHaveLength(1);
  });

  test("known engines, and an object with no engine, are clean", () => {
    const t = table`CREATE TABLE t (a UInt8) ENGINE = ReplacingMergeTree ORDER BY a`;
    const db = database`CREATE DATABASE d ENGINE = Atomic`;
    const bare = database`CREATE DATABASE e`;
    expect(sqlch101.check(ctxFor([["t", t], ["d", db], ["e", bare]]))).toEqual([]);
  });
});
