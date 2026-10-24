import { describe, expect, test } from "vitest";
import { resolveParserOptions } from "@intentius/chant/import/parser-options";
import { guessDialect, looksLikeTSql, sourceOption } from "./import-parser";
import { sqlPlugin } from "./plugin";

const TSQL = `SET ANSI_NULLS ON
GO
CREATE TABLE [dbo].[Orders] (
    [OrderID] INT IDENTITY (1, 1) NOT NULL,
    [Note] NVARCHAR (200) NULL,
    CONSTRAINT [PK_Orders] PRIMARY KEY CLUSTERED ([OrderID] ASC)
);
GO`;

const parse = (text: string, entries: string[] = []) => {
  const resolved = resolveParserOptions(sqlPlugin, entries);
  if ("error" in resolved) throw new Error(resolved.error);
  return sqlPlugin.templateParser!(resolved.options).parse(text);
};
const types = (ir: { resources: Array<{ type: string }> }) => [...new Set(ir.resources.map((r) => r.type))];

describe("a T-SQL file is not read as Postgres", () => {
  test("the dialect guess alone would have said Postgres, which is why the markers exist", () => {
    expect(guessDialect(TSQL)).toBe("postgres");
    expect(looksLikeTSql(TSQL)).toBe(true);
  });

  test("with no option, a T-SQL file is read as SQL Server and gives ClickHouse objects and diagnostics", () => {
    const ir = parse(TSQL);
    expect(types(ir)).toEqual(["ClickHouse::Table"]);
    expect(ir.diagnostics?.length).toBeGreaterThan(0);
    expect(ir.metadata).toMatchObject({ source: "sqlserver" });
  });

  test.each([
    ["a GO line", "CREATE TABLE a (x int)\nGO\n"],
    ["CLUSTERED", "CREATE CLUSTERED INDEX ix ON a (x)"],
    ["COLUMNSTORE", "CREATE CLUSTERED COLUMNSTORE INDEX cci ON a"],
    ["a bracketed name", "CREATE TABLE [a] (x int)"],
    ["nvarchar", "CREATE TABLE a (x nvarchar(5))"],
    ["IDENTITY(1,1)", "CREATE TABLE a (x int IDENTITY(1,1))"],
    ["an SSMS preamble", "SET QUOTED_IDENTIFIER ON\nCREATE TABLE a (x int)"],
    ["sp_addextendedproperty", "EXEC sp_addextendedproperty @name = N'a'"],
  ])("%s marks a file as T-SQL", (_, text) => {
    expect(looksLikeTSql(text)).toBe(true);
  });

  test.each([
    ["Postgres with arrays and a quoted name", 'CREATE TABLE "a" (x int[], y text[3], z int GENERATED ALWAYS AS IDENTITY, PRIMARY KEY (x))'],
    ["Postgres with a subscript", "CREATE FUNCTION f(a int[]) RETURNS int AS $$ SELECT a[1] $$ LANGUAGE sql"],
    ["ClickHouse", "CREATE TABLE a (x UInt8) ENGINE = MergeTree ORDER BY x"],
    ["ClickHouse naming a clustered column", "CREATE TABLE clustered (x UInt8) ENGINE = Memory"],
    ["a plain index", "CREATE INDEX ix ON a (x)"],
  ])("%s is not", (_, text) => {
    expect(looksLikeTSql(text)).toBe(false);
  });

  test("Postgres and ClickHouse files import as before", () => {
    expect(types(parse("CREATE TABLE a (x int PRIMARY KEY, y text)"))).toEqual(["Postgres::Table"]);
    expect(types(parse("CREATE TABLE a (x UInt8) ENGINE = MergeTree ORDER BY x"))).toEqual(["ClickHouse::Table"]);
    expect(parse("CREATE TABLE a (x int PRIMARY KEY)").diagnostics).toBeUndefined();
  });

  test("a dialect named by the author is kept: dialect=postgres on T-SQL fails as Postgres, it is not rerouted", () => {
    expect(() => parse(TSQL, ["dialect=postgres"])).toThrow(/Postgres DDL/);
  });
});

describe("--parser-option from=sqlserver", () => {
  test("is declared with the other options", () => {
    expect(sqlPlugin.parserOptions!().map((o) => o.name)).toEqual(["dialect", "from", "skipUndeclarable"]);
    expect(resolveParserOptions(sqlPlugin, ["from=sqlserver"])).toEqual({ options: { from: "sqlserver" } });
  });

  test("forces the T-SQL source on a file without markers", () => {
    const ir = parse("CREATE TABLE a (x int NOT NULL)", ["from=sqlserver"]);
    expect(types(ir)).toEqual(["ClickHouse::Table"]);
    expect(ir.diagnostics!.map((d) => d.ruleId)).toEqual(["SQLRV001", "SQLRV002"]);
  });

  test("a source other than sqlserver is refused, naming what is accepted", () => {
    expect(() => sourceOption({ from: "mysql" })).toThrow("expected sqlserver, got mysql");
  });

  test("cannot be combined with dialect", () => {
    expect(() => sourceOption({ from: "sqlserver", dialect: "clickhouse" })).toThrow(/cannot be combined with dialect/);
  });

  test("a lexing error is reported as an import error naming the position", () => {
    expect(() => parse("CREATE TABLE [a (x int)", ["from=sqlserver"])).toThrow(/unterminated \[identifier\] \(line 1, column 14\)/);
  });
});
