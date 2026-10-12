import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { parseCreate, type TableNode, type ViewNode } from "./parser";
import { SqlSyntaxError, tokenize, tokenizeText, untokenize } from "./tokens";

const parse = (sql: string) => parseCreate(tokenizeText(sql, 0));
const text = (sql: string, span?: { from: number; to: number }) =>
  span ? untokenize(tokenizeText(sql, 0).slice(span.from, span.to), () => "?").trim() : undefined;

describe("tokenizing a template", () => {
  test("is lossless: tokens give the raw text back, comments and spacing included", () => {
    const parts = ["CREATE TABLE t (\n  id UInt64, -- the key\n  /* block */ x ", " DEFAULT 'a''b'\n) ENGINE = Log"];
    expect(untokenize(tokenize(parts), (i) => "${" + i + "}")).toBe(parts.join("${0}"));
  });

  test("a name may start with a digit", () => {
    const node = parse("CREATE TABLE 00662_has_nullable (a UInt8) ENGINE = Memory") as TableNode;
    expect(node.columns[0]!.name).toBe("a");
  });

  test("an unterminated quote is located", () => {
    expect(() => tokenizeText("CREATE TABLE t (a String DEFAULT 'x) ENGINE = Log", 0)).toThrow(SqlSyntaxError);
  });
});

describe("parsing CREATE TABLE", () => {
  const sql = `CREATE TABLE IF NOT EXISTS db.events ON CLUSTER main (
    user_id UUID,
    kind LowCardinality(String) DEFAULT 'click' COMMENT 'what happened',
    ts DateTime64(3, 'UTC') CODEC(Delta, ZSTD(3)) TTL ts + INTERVAL 1 DAY,
    tags Array(String) DEFAULT ['a', 'b'],
    n Nullable(UInt32),
    total UInt64 MATERIALIZED n * 2,
    INDEX k kind TYPE bloom_filter(0.01) GRANULARITY 4,
    PROJECTION by_kind (SELECT kind, count() GROUP BY kind),
    CONSTRAINT c CHECK n > 0,
  )
  ENGINE = ReplicatedReplacingMergeTree('/t/{shard}', '{replica}', ts)
  PARTITION BY toYYYYMM(ts)
  ORDER BY (user_id, kind)
  SAMPLE BY user_id
  TTL ts + INTERVAL 30 DAY DELETE
  SETTINGS index_granularity = 8192, allow_nullable_key = 0
  COMMENT 'events'`;
  const node = parse(sql) as TableNode;

  test("reads the statement's structure", () => {
    expect(node.statement).toBe("table");
    expect(node.ifNotExists).toBe(true);
    expect(text(sql, node.name)).toBe("db.events");
    expect(text(sql, node.onCluster)).toBe("main");
    expect(node.columns.map((c) => c.name)).toEqual(["user_id", "kind", "ts", "tags", "n", "total"]);
    expect(node.indexes.map((i) => i.name)).toEqual(["k"]);
    expect(node.projections.map((p) => p.name)).toEqual(["by_kind"]);
    expect(node.constraints.map((c) => [c.name, c.kind])).toEqual([["c", "CHECK"]]);
  });

  test("keeps each expression as its source text", () => {
    const ts = node.columns[2]!;
    expect(text(sql, ts.type)).toBe("DateTime64(3, 'UTC')");
    expect(text(sql, ts.codec)).toBe("Delta, ZSTD(3)");
    expect(text(sql, ts.ttl)).toBe("ts + INTERVAL 1 DAY");
    expect(text(sql, node.columns[3]!.default!.expr)).toBe("['a', 'b']");
    expect(node.columns[5]!.default!.kind).toBe("MATERIALIZED");
    expect(node.engine!.name).toBe("ReplicatedReplacingMergeTree");
    expect(node.engine!.args!.map((a) => text(sql, a))).toEqual(["'/t/{shard}'", "'{replica}'", "ts"]);
    expect(text(sql, node.orderBy)).toBe("(user_id, kind)");
    expect(text(sql, node.ttl)).toBe("ts + INTERVAL 30 DAY DELETE");
    expect(node.settings!.map((s) => [s.key, text(sql, s.value)])).toEqual([
      ["index_granularity", "8192"],
      ["allow_nullable_key", "0"],
    ]);
    expect(text(sql, node.comment)).toBe("'events'");
  });

  test("a column named like a keyword is a column", () => {
    const t = parse("CREATE TABLE t (index UInt8, projection String, constraint UInt8) ENGINE = Log") as TableNode;
    expect(t.columns.map((c) => c.name)).toEqual(["index", "projection", "constraint"]);
  });

  test("the clauses may come in any order", () => {
    const t = parse("CREATE TABLE t (a UInt8) ORDER BY a ENGINE = MergeTree PARTITION BY a") as TableNode;
    expect(t.engine!.name).toBe("MergeTree");
  });

  test("CREATE TABLE ... AS a table, AS SELECT, CLONE AS and a table with no columns are refused, each saying why (#3911)", () => {
    expect(() => parse("CREATE TABLE t AS other")).toThrow(/AS <table> is not declared: the server copies the other table's columns/);
    expect(() => parse("CREATE TABLE t AS db.other ENGINE = Log")).toThrow(/AS <table> is not declared/);
    expect(() => parse("CREATE TABLE t ENGINE = Log AS SELECT 1 AS a")).toThrow(/expected the column list \(a table declared without one/);
    expect(() => parse("CREATE TABLE t AS SELECT 1 AS a")).toThrow(/AS SELECT is not declared/);
    expect(() => parse("CREATE TABLE t (a UInt8) ENGINE = Memory AS SELECT 1 AS a")).toThrow(/AS SELECT is not declared/);
    expect(() => parse("CREATE TABLE t CLONE AS other")).toThrow(/CLONE AS is not declared/);
    expect(() => parse("CREATE TABLE t EMPTY AS SELECT 1")).toThrow(/EMPTY AS SELECT is not declared/);
  });

  test("a table over a table function, with or without its columns (#3911)", () => {
    const bareSql = "CREATE TABLE t AS numbers(10)";
    const bare = parse(bareSql) as TableNode;
    expect(bare.columns).toEqual([]);
    expect(bare.engine).toBeUndefined();
    expect(text(bareSql, bare.asFunction)).toBe("numbers(10)");
    // As SHOW CREATE prints it: the inferred columns, then the call, then the comment.
    const shownSql = "CREATE TABLE default.tf\n(\n    `a` UInt64,\n    `b` String\n) AS remote('localhost', 'default.t')\nCOMMENT 'x'";
    const shown = parse(shownSql) as TableNode;
    expect(shown.columns.map((c) => c.name)).toEqual(["a", "b"]);
    expect(text(shownSql, shown.asFunction)).toBe("remote('localhost', 'default.t')");
    expect(shown.comment).toBeDefined();
    expect(() => parse("CREATE TABLE t AS numbers(10) ENGINE = Log")).toThrow(/no engine or storage clauses/);
  });

  test("the CREATE kinds chant does not declare are refused by name, with why (#3911)", () => {
    expect(() => parse("CREATE LIVE VIEW lv AS SELECT 1")).toThrow(/CREATE LIVE VIEW is not declared: the pinned server no longer has live views/);
    expect(() => parse("CREATE WINDOW VIEW wv AS SELECT 1")).toThrow(/CREATE WINDOW VIEW is not declared: a window view is experimental/);
    expect(() => parse("CREATE NAMED COLLECTION c AS user = 'u', password = 'p'")).toThrow(/CREATE NAMED COLLECTION is not declared: a named collection holds credentials/);
    expect(() => parse("CREATE MASKING POLICY m ON t UPDATE a = 'x' TO r")).toThrow(/only in ClickHouse Cloud/);
    expect(() => parse("CREATE WORKLOAD all")).toThrow(/CREATE WORKLOAD is not declared: a workload is server-level/);
    expect(() => parse("CREATE RESOURCE r (WRITE DISK d)")).toThrow(/CREATE RESOURCE is not declared/);
    expect(() => parse("CREATE TEMPORARY TABLE t (a UInt8)")).toThrow(/CREATE TEMPORARY TABLE is not declared/);
    expect(() => parse("CREATE INDEX ix ON t (b) TYPE minmax")).toThrow(/CREATE INDEX is not declared: a skip index belongs to its table/);
    expect(() => parse("CREATE QUOTA q")).toThrow(/CREATE QUOTA is access control: declare it with the quota tag/);
    expect(() => parse("CREATE SETTINGS PROFILE p")).toThrow(/settingsProfile tag/);
  });
});

describe("parsing views and databases", () => {
  test("a materialized view with a target, a column list and a refresh", () => {
    const sql =
      "CREATE MATERIALIZED VIEW mv REFRESH EVERY 1 HOUR APPEND TO dst (a UInt8, b) DEFINER = alice SQL SECURITY DEFINER AS SELECT a, b FROM src COMMENT 'x'";
    const v = parse(sql) as ViewNode;
    expect(v.materialized).toBe(true);
    expect(text(sql, v.refresh)).toBe("EVERY 1 HOUR");
    expect(v.append).toBe(true);
    expect(text(sql, v.to)).toBe("dst");
    expect(v.columns.map((c) => c.name)).toEqual(["a", "b"]);
    expect(text(sql, v.security)).toBe("DEFINER = alice SQL SECURITY DEFINER");
    expect(text(sql, v.select)).toBe("SELECT a, b FROM src");
  });

  test("a refreshable materialized view as SHOW CREATE prints it: the column list right after the schedule (#3911)", () => {
    const sql =
      "CREATE MATERIALIZED VIEW default.rmv\nREFRESH EVERY 1 HOUR OFFSET 5 MINUTES\n(\n    `a` UInt64\n)\nENGINE = MergeTree\nORDER BY a\nSETTINGS index_granularity = 8192\nDEFINER = default SQL SECURITY DEFINER\nAS SELECT a\nFROM default.t";
    const v = parse(sql) as ViewNode;
    expect(text(sql, v.refresh)).toBe("EVERY 1 HOUR OFFSET 5 MINUTES");
    expect(v.columns.map((c) => c.name)).toEqual(["a"]);
    expect(text(sql, v.orderBy)).toBe("a");
  });

  test("a view the server printed back, with its UUID", () => {
    const v = parse("CREATE VIEW default.v UUID '6a1b' (`x` UInt8) AS SELECT 1 AS x") as ViewNode;
    expect(v.columns[0]!.name).toBe("x");
  });

  test("a database with an engine and a comment", () => {
    const sql = "CREATE DATABASE IF NOT EXISTS analytics ENGINE = Replicated('/db', '{shard}', '{replica}') COMMENT 'a'";
    const d = parseCreate(tokenizeText(sql, 0));
    expect(d.statement).toBe("database");
  });
});

describe("interpolations", () => {
  test("stand where a name, a type, an engine or an expression goes", () => {
    const parts = ["CREATE TABLE ", " (", " ", ", b UInt8 DEFAULT ", ") ENGINE = ", " ORDER BY ", ""];
    const node = parseCreate(tokenize(parts)) as TableNode;
    expect(node.name.refs).toEqual([0]);
    expect(node.columns[0]!.nameSpan.refs).toEqual([1]);
    expect(node.columns[0]!.type!.refs).toEqual([2]);
    expect(node.columns[1]!.default!.expr!.refs).toEqual([3]);
    expect(node.engine!.nameSpan.refs).toEqual([4]);
    expect(node.orderBy!.refs).toEqual([5]);
  });
});

describe("syntax errors", () => {
  test("are located at the token, in the part it sits in", () => {
    const parts = ["CREATE TABLE t (\n  a UInt8,\n  b Strin g\n) ENGINE = Log"];
    try {
      parseCreate(tokenize(parts));
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(SqlSyntaxError);
      const e = err as SqlSyntaxError;
      expect(parts[0]!.slice(e.offset, e.offset + 1)).toBe("g");
    }
  });

  test("a truncated statement says so", () => {
    expect(() => parse("CREATE TABLE t (a UInt8")).toThrow(/expected '\)'|unexpected end/);
  });
});

describe("the ClickHouse test corpus", () => {
  // 300 statements from ClickHouse's own SQL tests (see testdata/NOTICE). A
  // statement the parser accepted when the fixture was cut must keep parsing.
  const corpus = JSON.parse(readFileSync(join(import.meta.dirname, "testdata", "clickhouse-tests-corpus.json"), "utf-8")) as string[];

  test("every statement parses", () => {
    const failed: string[] = [];
    for (const sql of corpus) {
      try {
        parse(sql);
      } catch (err) {
        failed.push(`${(err as Error).message}: ${sql.slice(0, 120)}`);
      }
    }
    expect(failed).toEqual([]);
    expect(corpus.length).toBe(300);
  });
});
