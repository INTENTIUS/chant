import { describe, expect, test } from "vitest";
import { translateSqlServer } from "./translate";
import { batches, tokenize } from "./lexer";
import { parseTsql } from "./parse";

const t = (sql: string, options = {}) => translateSqlServer(sql, options);
const table = (sql: string) => {
  const r = t(sql);
  expect(r.problems).toEqual([]);
  return r.objects.find((o) => o.type === "ClickHouse::Table")!.ddl;
};
const rules = (sql: string) => [...new Set(t(sql).diagnostics.map((d) => d.ruleId))].sort();
const of = (sql: string, ruleId: string) => t(sql).diagnostics.filter((d) => d.ruleId === ruleId);

describe("the lexer", () => {
  test("a [bracketed] name keeps a closing bracket written ]] and an N'string' is its value", () => {
    const toks = tokenize("CREATE TABLE [a]]b] (c nvarchar(5) DEFAULT N'it''s')");
    expect(toks.find((x) => x.kind === "qident")!.value).toBe("a]b");
    expect(toks.find((x) => x.kind === "string")!.value).toBe("it's");
  });

  test("GO alone on a line ends a batch, and a name that is GO inside a statement does not", () => {
    const toks = tokenize("SELECT 1\nGO\nSELECT 2 AS go\nGO 3\n");
    expect(batches(toks).map((b) => b.map((x) => x.value).join(" "))).toEqual(["SELECT 1", "SELECT 2 AS go"]);
  });

  test("comments are dropped and positions are 1-based", () => {
    const toks = tokenize("-- a\n/* b /* nested */ c */ CREATE");
    expect(toks).toHaveLength(1);
    expect(toks[0]).toMatchObject({ value: "CREATE", line: 2, column: 24 });
  });

  test("an unterminated bracket is an error with a position", () => {
    expect(() => tokenize("CREATE TABLE [x")).toThrow(/line 1/);
  });
});

describe("the parser", () => {
  test("statements need no semicolon: a CREATE TABLE and a CREATE INDEX in one batch are two", () => {
    const r = parseTsql("CREATE TABLE a (x int) CREATE INDEX ix ON a (x)");
    expect(r.statements.map((s) => s.kind)).toEqual(["table", "index"]);
  });

  test("ON DELETE SET NULL does not start a SET statement", () => {
    const r = parseTsql("CREATE TABLE a (x int, y int REFERENCES b (id) ON DELETE SET NULL ON UPDATE CASCADE);\nALTER TABLE a ADD CONSTRAINT fk FOREIGN KEY (x) REFERENCES b (id) ON DELETE SET NULL");
    expect(r.unread).toEqual([]);
    expect(r.statements.map((s) => s.kind)).toEqual(["table", "alter-constraint"]);
  });

  test("a statement it cannot read is returned with its words and the reason, not dropped", () => {
    const r = parseTsql("CREATE TABLE a (x int FROBNICATE)");
    expect(r.statements).toEqual([]);
    expect(r.unread[0]).toMatchObject({ text: expect.stringContaining("CREATE TABLE a"), reason: expect.stringContaining("FROBNICATE") });
  });
});

describe("a mechanical table", () => {
  const sql = `CREATE TABLE dbo.m (
    a int NOT NULL, b bigint NOT NULL, c nvarchar(50) NOT NULL, d datetime2(3) NOT NULL, e bit NOT NULL,
    f uniqueidentifier NOT NULL, g decimal(12,4) NOT NULL, h money NOT NULL,
    CONSTRAINT pk PRIMARY KEY CLUSTERED (a));`;

  test("maps every type with no finding about a type", () => {
    const ddl = table(sql);
    for (const line of ["a Int32", "b Int64", "c String", "d DateTime64(3)", "e Bool", "f UUID", "g Decimal(12, 4)", "h Decimal(19, 4)"]) expect(ddl).toContain(`    ${line}`);
    expect(ddl).not.toContain("Nullable");
  });

  test("the only findings are the two every table gets: the sort key and the engine", () => {
    expect(rules(sql)).toEqual(["SQLRV001", "SQLRV002"]);
  });

  test("the dbo schema is dropped from the name, and the table has no database", () => {
    const r = t(sql);
    expect(r.objects.map((o) => [o.type, o.database, o.name])).toEqual([["ClickHouse::Table", undefined, "m"]]);
  });
});

describe("the sort key", () => {
  const cols = "a int NOT NULL, b int NOT NULL, c datetime2(3) NOT NULL";

  test("a columnstore ORDER is the key, in either clause order, and the evidence names the index", () => {
    for (const tail of ["ORDER (c, a)", "WITH (MAXDOP = 1) ORDER (c, a)", "ORDER (c, a) WITH (DROP_EXISTING = ON)"]) {
      const sql = `CREATE TABLE f (${cols}, PRIMARY KEY NONCLUSTERED (a));\nGO\nCREATE CLUSTERED COLUMNSTORE INDEX cci ON f ${tail}`;
      expect(table(sql)).toContain("ORDER BY (c, a)");
      const d = of(sql, "SQLRV001")[0]!;
      expect(d.message).toContain("CREATE CLUSTERED COLUMNSTORE INDEX cci ORDER (c, a)");
      expect(d.message).toContain("passed over: PRIMARY KEY NONCLUSTERED");
    }
  });

  test("a columnstore with no ORDER names no key, so the primary key is used and the evidence says so", () => {
    const sql = `CREATE TABLE f (${cols}, PRIMARY KEY NONCLUSTERED (b));\nGO\nCREATE CLUSTERED COLUMNSTORE INDEX cci ON f`;
    expect(table(sql)).toContain("ORDER BY b");
    expect(of(sql, "SQLRV001")[0]!.message).toContain("cci has no ORDER clause");
  });

  test("a clustered index outranks a nonclustered primary key", () => {
    const sql = `CREATE TABLE f (${cols}, PRIMARY KEY NONCLUSTERED (a));\nGO\nCREATE CLUSTERED INDEX cx ON f (c DESC, b)`;
    expect(table(sql)).toContain("ORDER BY (c, b)");
    expect(of(sql, "SQLRV001")[0]!.message).toContain("descending in the source, ascending here: c");
  });

  test("a primary key with no keyword is the clustering key unless another structure is clustered", () => {
    expect(of(`CREATE TABLE f (${cols}, PRIMARY KEY (a))`, "SQLRV001")[0]!.message).toContain("clustering key");
    expect(of(`CREATE TABLE f (${cols}, PRIMARY KEY (a));\nGO\nCREATE CLUSTERED COLUMNSTORE INDEX c ON f`, "SQLRV001")[0]!.message).toContain("from the primary key");
  });

  test("a table with no key gets tuple() and a finding", () => {
    const sql = `CREATE TABLE f (${cols})`;
    expect(table(sql)).toContain("ORDER BY tuple()");
    expect(of(sql, "SQLRV001")[0]!.message).toContain("tuple()");
  });

  test("a nullable key column adds allow_nullable_key", () => {
    const sql = "CREATE TABLE f (a int NULL, b int NOT NULL);\nGO\nCREATE CLUSTERED INDEX cx ON f (a)";
    expect(table(sql)).toContain("SETTINGS allow_nullable_key = 1");
  });

  test("a key that names a computed column is passed over, and the next one is used", () => {
    const sql = "CREATE TABLE f (a int NOT NULL, b AS (a + 1) PERSISTED, PRIMARY KEY NONCLUSTERED (a));\nGO\nCREATE CLUSTERED INDEX cx ON f (b)";
    expect(table(sql)).toContain("ORDER BY a");
    expect(of(sql, "SQLRV001")[0]!.message).toContain("names a column that is not carried");
  });
});

describe("Nullable and defaults", () => {
  test("a column is nullable unless it is NOT NULL, a key column or an identity", () => {
    const ddl = table("CREATE TABLE f (a int, b int NOT NULL, c int PRIMARY KEY, d int IDENTITY(1,1))");
    expect(ddl).toContain("    a Nullable(Int32)");
    expect(ddl).toContain("    b Int32,");
    expect(ddl).toContain("    c Int32,");
    expect(ddl).toContain("    d Int32\n");
  });

  test("a nullable column with a default is a finding that names the default", () => {
    const sql = "CREATE TABLE f (n int NULL CONSTRAINT df DEFAULT ((7)))";
    expect(table(sql)).toContain("n Nullable(Int32) DEFAULT 7");
    const d = of(sql, "SQLRV003")[0]!;
    expect(d.message).toContain("it has the default 7");
    expect(d).toMatchObject({ line: 1, entity: "f" });
  });

  test("literal defaults are carried, strings quoted for ClickHouse", () => {
    const ddl = table("CREATE TABLE f (a int NOT NULL DEFAULT (-1), s nvarchar(5) NOT NULL DEFAULT N'it''s', n int NULL DEFAULT (NULL))");
    expect(ddl).toContain("a Int32 DEFAULT -1");
    expect(ddl).toContain("s String DEFAULT 'it\\'s'");
    expect(ddl).toContain("n Nullable(Int32)\n");
  });

  test.each([
    ["sysdatetime()", "datetime2(7)", "now64(7)"],
    ["getdate()", "datetime", "now64(3)"],
    ["getdate()", "date", "today()"],
    ["newid()", "uniqueidentifier", "generateUUIDv4()"],
  ])("the function default %s on %s is written as %s and flagged", (fn, type, expected) => {
    const sql = `CREATE TABLE f (c ${type} NOT NULL DEFAULT (${fn}))`;
    expect(table(sql)).toContain(`DEFAULT ${expected}`);
    expect(of(sql, "SQLRV008")).toHaveLength(1);
  });

  test("a default it cannot translate is dropped and said so", () => {
    const sql = "CREATE TABLE f (c nvarchar(20) NOT NULL DEFAULT (suser_sname()))";
    expect(table(sql)).not.toContain("DEFAULT");
    expect(of(sql, "SQLRV008")[0]!.message).toContain("suser_sname()");
  });

  test("a default added by ALTER TABLE ... ADD DEFAULT ... FOR is read", () => {
    const sql = "CREATE TABLE f (c int NOT NULL);\nGO\nALTER TABLE f ADD CONSTRAINT df DEFAULT (3) FOR c";
    expect(table(sql)).toContain("c Int32 DEFAULT 3");
  });
});

describe("identity, sequence, computed and generated columns", () => {
  test("identity is a plain column and a finding with the seed and increment", () => {
    const sql = "CREATE TABLE f (id bigint IDENTITY(10, 5) NOT NULL)";
    expect(table(sql)).toContain("id Int64");
    expect(of(sql, "SQLRV006")[0]!.message).toContain("IDENTITY(10, 5)");
  });

  test("a sequence default is dropped and a finding", () => {
    const sql = "CREATE TABLE f (id int NOT NULL DEFAULT (NEXT VALUE FOR dbo.s))";
    expect(table(sql)).not.toContain("DEFAULT");
    expect(of(sql, "SQLRV006")[0]!.message).toContain("NEXT VALUE FOR dbo.s");
  });

  test("a computed column is left out of the DDL with a comment and a finding naming its expression", () => {
    const sql = "CREATE TABLE f (a int NOT NULL, b AS (a * 2) PERSISTED)";
    const ddl = table(sql);
    expect(ddl).not.toMatch(/^\s+b /m);
    expect(ddl).toContain("-- computed column b AS (a * 2) is not carried");
    expect(of(sql, "SQLRV006")[0]!.message).toContain("AS (a * 2) PERSISTED");
  });

  test("a temporal table's period columns, SYSTEM_VERSIONING and PERIOD are findings", () => {
    const sql = `CREATE TABLE f (id int NOT NULL, vf datetime2 GENERATED ALWAYS AS ROW START NOT NULL, vt datetime2 GENERATED ALWAYS AS ROW END NOT NULL,
      PRIMARY KEY CLUSTERED (id), PERIOD FOR SYSTEM_TIME (vf, vt)) WITH (SYSTEM_VERSIONING = ON (HISTORY_TABLE = dbo.h))`;
    expect(of(sql, "SQLRV006").map((d) => d.message)).toEqual([expect.stringContaining("vf is filled by the system"), expect.stringContaining("vt is filled by the system")]);
    const options = of(sql, "SQLRV009")[0]!.message;
    expect(options).toContain("SYSTEM_VERSIONING = ON");
    expect(options).toContain("PERIOD FOR SYSTEM_TIME (vf, vt)");
  });
});

describe("constraints ClickHouse does not enforce", () => {
  const sql = `CREATE TABLE o (id int NOT NULL, c int NOT NULL, e nvarchar(9) NULL,
    CONSTRAINT pk PRIMARY KEY (id),
    CONSTRAINT fk FOREIGN KEY (c) REFERENCES dbo.cust (id),
    CONSTRAINT uq UNIQUE (e),
    CONSTRAINT ck CHECK (c > 0));
  GO
  ALTER TABLE o WITH CHECK ADD CONSTRAINT fk2 FOREIGN KEY (c) REFERENCES cust2 (id)`;

  test("each is a comment before the CREATE and one finding", () => {
    const ddl = table(sql);
    for (const c of ["-- FOREIGN KEY fk (c) REFERENCES dbo.cust (id)", "-- UNIQUE uq (e)", "-- CHECK ck (c > 0)", "-- FOREIGN KEY fk2 (c) REFERENCES cust2 (id)"]) expect(ddl).toContain(c);
    expect(ddl.indexOf("-- UNIQUE")).toBeLessThan(ddl.indexOf("CREATE TABLE"));
    expect(of(sql, "SQLRV005")).toHaveLength(4);
  });

  test("an ALTER TABLE ADD CONSTRAINT on a table the file does not create is a problem naming it", () => {
    const r = t("ALTER TABLE ghost ADD CONSTRAINT x CHECK (a > 1)");
    expect(r.problems).toEqual([expect.stringContaining("ghost")]);
  });
});

describe("indexes", () => {
  const base = "CREATE TABLE f (a int NOT NULL, b int NOT NULL, c nvarchar(5) NOT NULL);\nGO\n";

  test("a nonclustered index is not carried and says what a skip index could do", () => {
    const d = of(`${base}CREATE NONCLUSTERED INDEX ix ON f (b) INCLUDE (c) WHERE b > 1`, "SQLRV009")[0]!;
    expect(d.message).toContain("ix, a nonclustered index on (b), is not carried");
    expect(d.message).toContain("INCLUDE (c)");
    expect(d.message).toContain("skip index");
  });

  test("a unique index is a unique constraint comment and a finding", () => {
    const sql = `${base}CREATE UNIQUE NONCLUSTERED INDEX ux ON f (b)`;
    expect(table(sql)).toContain("-- UNIQUE ux (b)");
    expect(of(sql, "SQLRV005")).toHaveLength(1);
  });

  test("an index declared inside CREATE TABLE is read like a separate one", () => {
    const sql = "CREATE TABLE f (a int NOT NULL, INDEX ix NONCLUSTERED (a) WITH (DATA_COMPRESSION = ROW))";
    expect(of(sql, "SQLRV009").map((d) => d.message).join("\n")).toContain("ix, a nonclustered index");
  });

  test("an index on a table or view the file does not create is a problem", () => {
    expect(t("CREATE INDEX ix ON nowhere (a)").problems[0]).toContain("nowhere");
    expect(t("CREATE VIEW v AS SELECT 1 AS a;\nGO\nCREATE UNIQUE CLUSTERED INDEX ix ON v (a)").problems[0]).toContain("indexed view");
  });
});

describe("what it refuses, by name", () => {
  test.each([
    ["CREATE TRIGGER dbo.trg_audit ON dbo.t AFTER INSERT AS BEGIN SELECT 1 END", "trigger dbo.trg_audit"],
    ["CREATE PROCEDURE [dbo].[usp_load] @x int AS SELECT @x", "procedure dbo.usp_load"],
    ["CREATE OR ALTER PROC usp_two AS SELECT 1", "procedure usp_two"],
    ["CREATE FUNCTION [Application].DetermineCustomerAccess(@CityID int) RETURNS TABLE AS RETURN (SELECT 1 AS a)", "function Application.DetermineCustomerAccess"],
    ["CREATE SEQUENCE dbo.s START WITH 1", "sequence dbo.s"],
    ["CREATE TYPE dbo.flag FROM bit", "type dbo.flag"],
    ["EXEC sp_rename 'a', 'b'", "statement"],
    ["INSERT INTO t VALUES (1)", "statement"],
  ])("%s is refused as %s", (sql, name) => {
    const r = t(`CREATE TABLE ok (a int NOT NULL);\nGO\n${sql}`);
    expect(r.problems).toHaveLength(1);
    expect(r.problems[0]).toContain(name);
    expect(r.problems[0]).toMatch(/\(line \d+\)/);
  });

  test("a trigger body with a CREATE inside it does not leak statements", () => {
    const r = t("CREATE TRIGGER trg ON t AFTER INSERT AS BEGIN CREATE TABLE inner_t (a int); INSERT INTO x VALUES (1); END");
    expect(r.problems).toHaveLength(1);
    expect(r.objects).toEqual([]);
  });

  test("a column of a type it does not know names the table, the column and the type", () => {
    const r = t("CREATE TABLE f (a int NOT NULL, v sql_variant, w dbo.flag)");
    expect(r.problems).toEqual([expect.stringContaining("f.v (line 1): sql_variant"), expect.stringContaining("f.w (line 1): the type flag")]);
    expect(r.objects).toEqual([]);
  });

  test("with skipUnreadable the rest imports and each refusal is a warning that names it", () => {
    const r = t("CREATE TABLE ok (a int NOT NULL);\nGO\nCREATE TRIGGER trg ON ok AFTER INSERT AS SELECT 1", { skipUnreadable: true });
    expect(r.problems).toEqual([]);
    expect(r.objects.map((o) => o.name)).toEqual(["ok"]);
    const left = r.diagnostics.find((d) => d.message.startsWith("Left out"))!;
    expect(left).toMatchObject({ severity: "warning", ruleId: "SQLRV011" });
    expect(left.message).toContain("trigger trg");
  });
});

describe("what it notes without a decision", () => {
  test("session settings and DROPs are info diagnostics, not silence", () => {
    const r = t("SET ANSI_NULLS ON\nGO\nDROP TABLE IF EXISTS dbo.old;\nGO\nUSE shop\nGO\nCREATE TABLE a (x int NOT NULL)");
    const info = r.diagnostics.filter((d) => d.severity === "info");
    expect(info.map((d) => d.entity)).toEqual(["SET ANSI_NULLS ON", "DROP TABLE IF EXISTS dbo.old", "USE shop"]);
    expect(r.problems).toEqual([]);
  });

  test("a description becomes a COMMENT; another property is an info diagnostic", () => {
    const sql = `CREATE TABLE a (x int NOT NULL);
GO
EXECUTE sp_addextendedproperty @name = N'Description', @value = N'About a', @level0type = N'SCHEMA', @level0name = N'dbo', @level1type = N'TABLE', @level1name = N'a';
GO
EXECUTE sp_addextendedproperty @name = N'Description', @value = 'The x', @level0type = N'SCHEMA', @level0name = N'dbo', @level1type = N'TABLE', @level1name = N'a', @level2type = N'COLUMN', @level2name = N'x';
GO
EXECUTE sp_addextendedproperty @name = N'Owner', @value = 'finance', @level0type = N'SCHEMA', @level0name = N'dbo', @level1type = N'TABLE', @level1name = N'a';`;
    const ddl = table(sql);
    expect(ddl).toContain("x Int32 COMMENT 'The x'");
    expect(ddl).toContain("COMMENT 'About a'");
    const info = t(sql).diagnostics.filter((d) => d.severity === "info");
    expect(info).toHaveLength(1);
    expect(info[0]!.message).toContain("Owner = finance");
  });
});

describe("schemas", () => {
  test("a schema other than dbo is a database, created once, before the tables in it", () => {
    const r = t("CREATE TABLE [Sales].[A] (x int NOT NULL);\nGO\nCREATE TABLE Sales.B (y int NOT NULL)");
    expect(r.objects.map((o) => [o.type, o.database ?? "", o.name])).toEqual([
      ["ClickHouse::Database", "", "Sales"],
      ["ClickHouse::Table", "Sales", "A"],
      ["ClickHouse::Table", "Sales", "B"],
    ]);
    expect(r.diagnostics.find((d) => d.ruleId === "SQLRV011")!.message).toContain("Schema Sales becomes the database Sales");
  });

  test("a CREATE SCHEMA in the file is the database, with no note about it", () => {
    const r = t("CREATE SCHEMA Sales AUTHORIZATION dbo;\nGO\nCREATE TABLE Sales.A (x int NOT NULL)");
    expect(r.objects[0]).toMatchObject({ type: "ClickHouse::Database", name: "Sales" });
    expect(r.diagnostics.filter((d) => d.ruleId === "SQLRV011")).toEqual([]);
  });

  test("names are matched without regard to case, as SQL Server does", () => {
    const r = t("CREATE TABLE Sales.Orders (Id int NOT NULL);\nGO\nCREATE CLUSTERED INDEX cx ON sales.orders (ID)");
    expect(r.problems).toEqual([]);
    expect(r.objects.find((o) => o.name === "Orders")!.ddl).toContain("ORDER BY Id");
  });

  test("a name that is not a plain identifier is backquoted", () => {
    expect(table("CREATE TABLE [my table] ([my col] int NOT NULL)")).toContain("CREATE TABLE `my table`\n(\n    `my col` Int32");
  });
});

describe("views", () => {
  test("the body is copied with identifiers requoted and dbo dropped, and a finding lists the T-SQL it found", () => {
    const sql = "CREATE VIEW [WebApi].[V] (a, b) WITH SCHEMABINDING AS SELECT TOP (5) [x].[a], ISNULL(b, N'z') AS b FROM dbo.[t x] AS x NOLOCK;";
    const r = t(sql);
    const v = r.objects.find((o) => o.type === "ClickHouse::View")!;
    expect(v.ddl).toBe("CREATE VIEW WebApi.V AS\nSELECT TOP (5) x.a, ISNULL(b, 'z') AS b FROM `t x` AS x NOLOCK");
    const d = r.diagnostics.find((x) => x.ruleId === "SQLRV010")!;
    expect(d.severity).toBe("warning");
    expect(d.message).toContain("T-SQL constructs found by name: ISNULL, NOLOCK, TOP");
    expect(d.message).toContain("the column list (a, b) is not carried");
    expect(d.message).toContain("view options not carried: SCHEMABINDING");
  });

  test("a view with no T-SQL-only word still raises the finding, and says the server decides", () => {
    const d = of("CREATE VIEW v AS SELECT a FROM t", "SQLRV010")[0]!;
    expect(d.message).toContain("no T-SQL-only construct was found by name");
  });
});

describe("storage options", () => {
  test("filegroups, TEXTIMAGE_ON, data compression and partition schemes are listed in one finding per table", () => {
    const sql = `CREATE TABLE f (a int NOT NULL, CONSTRAINT pk PRIMARY KEY CLUSTERED (a) WITH (DATA_COMPRESSION = PAGE) ON [PRIMARY]) ON [PS_Date] ([a]) TEXTIMAGE_ON [PRIMARY]`;
    const d = of(sql, "SQLRV009");
    expect(d).toHaveLength(1);
    for (const w of ["ON [PS_Date] ([a])", "TEXTIMAGE_ON [PRIMARY]", "DATA_COMPRESSION = PAGE"]) expect(d[0]!.message).toContain(w);
  });

  test("a collation and a column option are findings on the column", () => {
    const sql = "CREATE TABLE f (a nvarchar(5) COLLATE Latin1_General_CI_AS NOT NULL, b uniqueidentifier ROWGUIDCOL NOT NULL, c nvarchar(9) SPARSE NULL)";
    expect(of(sql, "SQLRV007")[0]!).toMatchObject({ line: 1 });
    expect(of(sql, "SQLRV007")[0]!.message).toContain("Latin1_General_CI_AS");
    expect(of(sql, "SQLRV009").map((d) => d.message)).toEqual([expect.stringContaining("ROWGUIDCOL"), expect.stringContaining("SPARSE")]);
  });
});

describe("LowCardinality", () => {
  test("a String column named for a small set is a candidate and keeps String", () => {
    const sql = "CREATE TABLE f (order_status nvarchar(20) NOT NULL, notes nvarchar(20) NOT NULL)";
    expect(table(sql)).toContain("order_status String,");
    const d = of(sql, "SQLRV004");
    expect(d).toHaveLength(1);
    expect(d[0]!.message).toContain("the declared length is 20");
  });
});

describe("diagnostics carry the source position", () => {
  test("a column finding points at the column's line and column", () => {
    const sql = "CREATE TABLE f (\n  a int NOT NULL,\n    b int NULL\n)";
    expect(of(sql, "SQLRV003")[0]).toMatchObject({ line: 3, column: 5 });
  });
});
