/**
 * A table over a table function (#3911): `CREATE TABLE t AS numbers(10)`,
 * with or without its columns, as the tag reads it, as the server prints it
 * back, and the one statement a change takes. `live/kinds.e2e.test.ts` runs
 * it against a server.
 */

import { describe, expect, test } from "vitest";
import { table, CLICKHOUSE_ENTITY_TYPES } from "./entities";
import { canonicalObject, objectKey } from "./plan/normalize";
import { diffSchemas } from "./plan/diff";
import { planStatements, type DeclaredObject } from "./apply/statements";
import { renderStatement } from "./topology";

const shown = "CREATE TABLE default.nums\n(\n    `number` UInt64\n) AS numbers(10)\nCOMMENT 'counting'";

describe("a table over a table function", () => {
  test("the tag reads the call, and the columns when written", () => {
    const bare = table`CREATE TABLE default.nums AS numbers(10) COMMENT 'counting'`;
    expect(bare.props).toMatchObject({ name: "nums", database: "default", asFunction: "numbers(10)", columns: [], comment: "counting" });
    expect(bare.props.engine).toBeUndefined();
    const typed = table`CREATE TABLE default.nums (number UInt64) AS numbers(10)`;
    expect(typed.props.columns.map((c) => [c.name, c.type])).toEqual([["number", "UInt64"]]);
  });

  test("a declaration with no columns agrees with the columns the server inferred; one that lists them is compared on them", () => {
    const same = (declared: string) => diffSchemas([{ key: "k", canonical: canonicalObject(shown) }], [{ key: "k", canonical: canonicalObject(declared) }]).changes;
    expect(same("CREATE TABLE default.nums AS numbers(10) COMMENT 'counting'")).toEqual([]);
    expect(same("CREATE TABLE default.nums (number UInt64) AS numbers(10) COMMENT 'counting'")).toEqual([]);
    expect(same("CREATE TABLE default.nums (number UInt32) AS numbers(20) COMMENT 'counting'").map((c) => [c.field, c.rule, c.class])).toEqual([
      ["asFunction", "SQLCH219", "metadata"],
      ["columns.number", "SQLCH219", "metadata"],
    ]);
  });

  test("a change replaces it whole, its comment with it; a table with data becoming one is a rebuild", () => {
    const ddl = "CREATE TABLE default.nums AS numbers(20)";
    const canonical = canonicalObject(ddl);
    const obj: DeclaredObject = { exportName: "nums", type: CLICKHOUSE_ENTITY_TYPES.table, key: objectKey(canonical), ddl, canonical, dependsOn: [] };
    const live = canonicalObject(shown);
    const changes = diffSchemas([{ key: obj.key, canonical: live }], [{ key: obj.key, canonical }]).changes;
    expect(changes.map((c) => c.field)).toEqual(["comment", "asFunction"]);
    const entry = planStatements({ declared: [obj], changes, current: new Map([[obj.key, live]]) }).objects[0]!;
    expect(entry.verdict === "alter" ? entry.steps.map((s) => s.sql) : []).toEqual(["CREATE OR REPLACE TABLE default.nums AS numbers(20) COMMENT '[chant managed-by=chant]'"]);

    const stored = canonicalObject("CREATE TABLE default.nums (number UInt64) ENGINE = MergeTree ORDER BY number");
    const rebuild = diffSchemas([{ key: obj.key, canonical: stored }], [{ key: obj.key, canonical }]).changes;
    expect(rebuild.map((c) => [c.field, c.rule, c.class])).toEqual([["asFunction", "SQLCH223", "rebuild"]]);
  });

  test("ON CLUSTER after the name", () => {
    expect(renderStatement("CREATE TABLE default.nums AS numbers(10)", { kind: "cluster", cluster: "main" })).toBe("CREATE TABLE default.nums ON CLUSTER `main` AS numbers(10)");
  });
});
