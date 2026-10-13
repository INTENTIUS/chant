/**
 * SQL user-defined functions (#3682): the `func` tag, a function keyed
 * apart from any database, a changed lambda replacing it (SQLCH260), no
 * marker and no restamp, and `ON CLUSTER` per topology.
 * `live/functions.e2e.test.ts` runs them against a server.
 */

import { describe, expect, test } from "vitest";
import { func, table, CLICKHOUSE_ENTITY_TYPES } from "./entities";
import { canonicalObject, objectKey, scopeOf } from "./plan/normalize";
import { diffSchemas } from "./plan/diff";
import { CLASSIFIER_RULES } from "./plan/rules";
import { createStatement, dropStatement, planStatements, type DeclaredObject } from "./apply/statements";
import { renderStatement } from "./topology";

const DECLARED = "CREATE FUNCTION linear AS (x, k, b) -> k*x + b";
// What clickhouse-server 26.8.15.10 prints for DECLARED (`system.functions.create_query`).
const SHOWN = "CREATE FUNCTION linear AS (x, k, b) -> ((k * x) + b)";

const declared = (ddl: string): DeclaredObject => {
  const canonical = canonicalObject(ddl);
  return { exportName: "linear", type: CLICKHOUSE_ENTITY_TYPES.function, key: objectKey(canonical), ddl, canonical, dependsOn: [] };
};

describe("the func tag", () => {
  test("parses the name, the parameters and the expression; a function has no database", () => {
    const f = func([DECLARED] as unknown as TemplateStringsArray);
    expect(f.entityType).toBe("ClickHouse::Function");
    expect(f.sqlName).toBe("linear");
    expect(f.props).toMatchObject({ name: "linear", params: ["x", "k", "b"], body: "k*x + b" });
    expect(func(["CREATE FUNCTION twice AS x -> x * 2"] as unknown as TemplateStringsArray).props.params).toEqual(["x"]);
  });

  test("a qualified name, a missing arrow and another statement are refused", () => {
    expect(() => func(["CREATE FUNCTION shop.linear AS (x) -> x"] as unknown as TemplateStringsArray)).toThrow(/no database/);
    expect(() => func(["CREATE FUNCTION linear AS (x) x"] as unknown as TemplateStringsArray)).toThrow(/expected ->/);
    expect(() => table([DECLARED] as unknown as TemplateStringsArray)).toThrow(/use the func tag/);
  });

  test("keyed and scoped apart from a database of the same name", () => {
    const f = canonicalObject("CREATE FUNCTION shop AS (x) -> x");
    const db = canonicalObject("CREATE DATABASE shop");
    expect([objectKey(f), objectKey(db)]).toEqual(["function shop", "shop"]);
    expect([scopeOf(f), scopeOf(db)]).toEqual(["function shop", "shop"]);
  });
});

describe("a function compared and changed", () => {
  test("a changed expression is SQLCH260; the server's formatting is left to its formatter", () => {
    const changes = diffSchemas([{ key: "f", canonical: canonicalObject(SHOWN) }], [{ key: "f", canonical: canonicalObject(DECLARED) }]).changes;
    // The rules leave the parentheses the server adds; a plan against a server asks its formatter (`dropFormattingOnly`).
    expect(changes.map((c) => [c.field, c.rule])).toEqual([["lambda", "SQLCH260"]]);
    expect(CLASSIFIER_RULES.SQLCH260.class).toBe("metadata");
    expect(diffSchemas([{ key: "f", canonical: canonicalObject(DECLARED) }], [{ key: "f", canonical: canonicalObject("CREATE FUNCTION linear AS (x, k, b) -> k * x + b") }]).changes).toEqual([]);
  });

  test("created as declared, with no marker; replaced with CREATE OR REPLACE; never restamped", () => {
    const marker = { stack: "shop", env: "prod" };
    expect(createStatement(declared(DECLARED), marker)).toBe(DECLARED);
    const after = declared("CREATE FUNCTION linear AS (x, k, b) -> k*x + b + 1");
    const current = new Map([[after.key, canonicalObject(DECLARED)]]);
    const changes = diffSchemas([{ key: after.key, canonical: canonicalObject(DECLARED) }], [{ key: after.key, canonical: after.canonical }]).changes;
    const plan = planStatements({ declared: [after], changes, current, marker, carriesMarker: () => false });
    const entry = plan.objects[0]!;
    expect(entry.verdict === "alter" ? entry.steps.map((s) => s.sql) : []).toEqual(["CREATE OR REPLACE FUNCTION linear AS (x, k, b) -> k*x + b + 1"]);
    // As declared, and with no marker to carry: nothing is sent.
    const same = planStatements({ declared: [declared(DECLARED)], changes: [], current: new Map([[after.key, canonicalObject(DECLARED)]]), marker, carriesMarker: () => false });
    expect(same.objects[0]!.verdict === "alter" ? same.objects[0]!.steps : ["?"]).toEqual([]);
    expect(dropStatement(CLICKHOUSE_ENTITY_TYPES.function, undefined, "linear")).toBe("DROP FUNCTION `linear`");
  });

  test("ON CLUSTER on a cluster, and in the replicated topology its cluster, since a function is in no database", () => {
    expect(renderStatement(DECLARED, { kind: "cluster", cluster: "main" })).toBe("CREATE FUNCTION linear ON CLUSTER `main` AS (x, k, b) -> k*x + b");
    expect(renderStatement(DECLARED, { kind: "replicated", cluster: "main" })).toBe("CREATE FUNCTION linear ON CLUSTER `main` AS (x, k, b) -> k*x + b");
    expect(renderStatement(DECLARED, { kind: "replicated" })).toBe(DECLARED);
    expect(renderStatement(DECLARED, { kind: "single" })).toBe(DECLARED);
    expect(renderStatement("DROP FUNCTION `linear`", { kind: "cluster", cluster: "main" })).toBe("DROP FUNCTION `linear` ON CLUSTER `main`");
  });
});

describe("importing a function", () => {
  test("the server's statement becomes a func declaration", async () => {
    const { ClickHouseSqlParser } = await import("./import/parser");
    const { ClickHouseGenerator } = await import("./import/generator");
    const ir = new ClickHouseSqlParser().parse(`${SHOWN};`);
    expect(ir.resources.map((r) => [r.logicalId, r.type])).toEqual([["linear", "ClickHouse::Function"]]);
    const [file] = new ClickHouseGenerator().generate(ir);
    expect(file!.content).toContain('import { func } from "@intentius/chant-lexicon-sql/clickhouse";');
    expect(file!.content).toContain("export const linear = func`");
  });
});
