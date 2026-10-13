/**
 * A clause chant's parser does not know (#3872): the statement is kept as
 * written, the build warns naming where it is, the rest of the object is
 * read, and a plan classes a change in the clause as one to review.
 */

import { describe, expect, test } from "vitest";
import { mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "@intentius/chant/build";
import { tokenizeText as chTokens } from "./clickhouse/tokens";
import { parseCreate, type TableNode } from "./clickhouse/parser";
import { tokenizeText as pgTokens } from "./postgres/tokens";
import { parseStatements, type IndexNode, type TableNode as PgTableNode } from "./postgres/parser";
import { table, view, database } from "./clickhouse/entities";
import { table as pgTable } from "./postgres/entities";
import { readSqlFile, sqlFileEntities, SqlFileError } from "./sql-files";
import { canonicalObject } from "./clickhouse/plan/normalize";
import { diffSchemas } from "./clickhouse/plan/diff";
import { diffPgSchemas } from "./postgres/plan/diff";
import { diffObject, type PgSchemaObject } from "./postgres/plan/schema";
import { planStatements } from "./clickhouse/apply/statements";
import { sqlSerializer, unparsedWarnings } from "./serializer";
import { sqlPlugin } from "./plugin";
import { renderSqlTypes } from "./sql-types";
import type { Declarable } from "@intentius/chant/declarable";

const ch = (sql: string) => parseCreate(chTokens(sql, 0));
const pg = (sql: string) => parseStatements(pgTokens(sql, 0))[0]!;

describe("the ClickHouse parser keeps a clause it does not know", () => {
  test("after the storage clauses, on a column, before a view's AS, in a database and a dictionary", () => {
    const t = ch("CREATE TABLE a.t (x UInt64, k String ENCRYPTED WITH 'k1', y UInt8) ENGINE = MergeTree ORDER BY x PARTITION_STRATEGY = 'hourly' SETTINGS index_granularity = 8192") as TableNode;
    expect(t.unknown?.map((u) => [u.clause, u.column])).toEqual([
      ["ENCRYPTED WITH", "k"],
      ["PARTITION_STRATEGY", undefined],
    ]);
    // What follows the clause is still read.
    expect(t.columns.map((c) => c.name)).toEqual(["x", "k", "y"]);
    expect(t.settings?.map((s) => s.key)).toEqual(["index_granularity"]);

    expect(ch("CREATE VIEW a.v SQL_CACHE = 'on' AS SELECT 1").unknown?.map((u) => u.clause)).toEqual(["SQL_CACHE"]);
    expect(ch("CREATE DATABASE d ENGINE = Atomic SHARDING_MODE 'auto' COMMENT 'x'").unknown?.map((u) => u.clause)).toEqual(["SHARDING_MODE"]);
    expect(
      ch("CREATE DICTIONARY a.d (id UInt64, v String DEFAULT '' SPARSE) PRIMARY KEY id SOURCE(NULL()) LAYOUT(FLAT()) LIFETIME(0) WARMUP(10)").unknown?.map((u) => [u.clause, u.column]),
    ).toEqual([
      ["SPARSE", "v"],
      ["WARMUP", undefined],
    ]);
    expect(ch("CREATE TABLE a.t (x UInt64) ENGINE = MergeTree ORDER BY x").unknown).toBeUndefined();
  });

  test("and still fails on what is malformed", () => {
    // One letter from a clause it knows: a misspelling.
    expect(() => ch("CREATE TABLE a.t (x UInt64) ENGINE = MergeTree ORDR BY x")).toThrow(/one letter from ORDER/);
    expect(() => ch("CREATE TABLE a.t (x UInt64 CODCE(ZSTD))")).toThrow(/one letter from CODEC/);
    // Unbalanced parentheses, a word that is not a key word, an unknown statement kind.
    expect(() => ch("CREATE TABLE a.t (x UInt64) ENGINE = Log FUTURE_THING (a")).toThrow(/unbalanced parentheses|expected/);
    expect(() => ch("CREATE TABLE a.t (x UInt64) ENGINE = Log 'stray'")).toThrow(/unexpected token/);
    expect(() => ch("CREATE NAMED COLLECTION c AS a = 1")).toThrow(/NAMED COLLECTION is not declared/);
    expect(() => ch("CREATE SOMETHING c")).toThrow(/expected DATABASE, TABLE/);
  });
});

describe("the Postgres parser keeps a clause it does not know", () => {
  test("after a table's column list, on a column, after an index's elements, before a view's AS, in a sequence", () => {
    const t = pg("CREATE TABLE app.t (id bigint PRIMARY KEY, note text INVISIBLE, n int NOT NULL) STORAGE_CLASS 'cold' TABLESPACE fast") as PgTableNode;
    expect(t.unknown?.map((u) => [u.clause, u.column])).toEqual([
      ["INVISIBLE", "note"],
      ["STORAGE_CLASS", undefined],
    ]);
    expect(t.columns.map((c) => c.name)).toEqual(["id", "note", "n"]);
    expect(t.tablespace).toBeDefined();
    expect((pg("CREATE INDEX i ON app.t (id) INVISIBLE") as IndexNode).unknown?.map((u) => u.clause)).toEqual(["INVISIBLE"]);
    expect(pg("CREATE VIEW app.v SECURITY_BARRIER_HINT AS SELECT 1").statement).toBe("view");
    expect(pg("CREATE SEQUENCE app.s CYCLE SEQUENCE_KIND local").statement).toBe("sequence");
  });

  test("and still fails on what is malformed, and on what it refuses on purpose", () => {
    expect(() => pg("CREATE TABLE app.t (id int) TABLESPAC fast")).toThrow(/one letter from TABLESPACE/);
    expect(() => pg("CREATE TABLE app.t (id int NOT NUL)")).toThrow();
    expect(() => pg("CREATE ROLE r PASSWORD 'x'")).toThrow(/password/);
    expect(() => pg("CREATE TABLE app.t (id int) WITHOUT_SOMETHING (")).toThrow();
  });
});

describe("a tag keeps the clause in its DDL and names it in props", () => {
  test("ClickHouse", () => {
    const t = table`CREATE TABLE a.t (
  x UInt64,
  k String ENCRYPTED WITH 'k1'
) ENGINE = MergeTree ORDER BY x
PARTITION_STRATEGY = 'hourly'`;
    expect(t.props.ddl).toContain("PARTITION_STRATEGY = 'hourly'");
    expect(t.props.ddl).toContain("ENCRYPTED WITH 'k1'");
    expect(t.props.unparsed).toEqual([
      { clause: "ENCRYPTED WITH", text: "ENCRYPTED WITH 'k1'", column: "k", line: 3 },
      { clause: "PARTITION_STRATEGY", text: "PARTITION_STRATEGY = 'hourly'", line: 5 },
    ]);
    expect(t.props.orderBy).toBe("x");
    expect(Object.keys((t as unknown as { columns: object }).columns)).toEqual(["x", "k"]);
    expect(database`CREATE DATABASE a`.props.unparsed).toBeUndefined();
    expect(view`CREATE VIEW a.v AS SELECT x FROM ${t}`.props.unparsed).toBeUndefined();
  });

  test("Postgres", () => {
    const t = pgTable`CREATE TABLE app.t (id bigint PRIMARY KEY, note text) STORAGE_CLASS 'cold'`;
    expect(t.props.ddl).toContain("STORAGE_CLASS 'cold'");
    expect(t.props.unparsed).toEqual([{ clause: "STORAGE_CLASS", text: "STORAGE_CLASS 'cold'", line: 1 }]);
  });
});

const CH_FILE = `CREATE DATABASE analytics;

CREATE TABLE analytics.events (
  ts DateTime,
  kind String ENCRYPTED WITH 'k1'
) ENGINE = MergeTree ORDER BY ts
PARTITION_STRATEGY = 'hourly';
`;

describe("a .sql file", () => {
  test("reads, with each clause and its line in the file", () => {
    const [db, events] = readSqlFile("clickhouse", CH_FILE, { origin: "src/schema.sql" });
    expect(db!.unparsed).toBeUndefined();
    expect(events!.line).toBe(3);
    expect(events!.unparsed).toEqual([
      { clause: "ENCRYPTED WITH", line: 5, column: "kind" },
      { clause: "PARTITION_STRATEGY", line: 7 },
    ]);
    const pgObjects = readSqlFile("postgres", "CREATE SCHEMA app;\nCREATE TABLE app.t (\n  id bigint\n) STORAGE_CLASS 'cold';\nCOMMENT ON TABLE app.t IS 'x';", { origin: "db.sql" });
    expect(pgObjects[1]!.unparsed).toEqual([{ clause: "STORAGE_CLASS", line: 4 }]);
  });

  test("builds entities whose warnings name the file and line", () => {
    const entities = sqlFileEntities("clickhouse", [{ origin: "src/schema.sql", ddl: CH_FILE }]);
    const warnings = unparsedWarnings(entities);
    expect(warnings).toHaveLength(2);
    expect(warnings[0]).toMatch(/^src\/schema\.sql:5: analytics\.events has a clause chant does not read, ENCRYPTED WITH on column kind\. It is sent as written/);
    expect(warnings[1]).toMatch(/^src\/schema\.sql:7: analytics\.events has a clause chant does not read, PARTITION_STRATEGY\./);
  });

  test("statements that are not schema still fail", () => {
    expect(() => readSqlFile("clickhouse", "CREATE DATABASE a;\nDROP TABLE a.t", { origin: "x.sql" })).toThrow(SqlFileError);
    expect(() => readSqlFile("postgres", "INSERT INTO app.t VALUES (1)", { origin: "x.sql" })).toThrow(/not a statement that declares an object/);
  });
});

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

describe("a build", () => {
  test("succeeds with a warning, and the clause is in the DDL it writes", async () => {
    const path = join(repoRoot, ".cache", `sql-3872-${process.pid}`);
    await rm(path, { recursive: true, force: true });
    await mkdir(join(path, "src"), { recursive: true });
    const dir = await realpath(path);
    await writeFile(join(dir, "src", "schema.sql"), CH_FILE);
    try {
      const result = await build(join(dir, "src"), [sqlSerializer], undefined, {
        lexicons: ["sql"],
        intrinsics: sqlPlugin.intrinsics?.() ?? [],
        buildRoots: [(ctx) => sqlPlugin.buildRoots!({ projectRoot: dir, config: {}, entities: ctx.entities, ...(ctx.sourceDir ? { sourceDir: ctx.sourceDir } : {}) })],
      });
      expect(result.errors.map((e) => e.message)).toEqual([]);
      expect(result.warnings.filter((w) => /chant does not read/.test(w))).toHaveLength(2);
      const out = result.outputs.get("sql");
      const files = typeof out === "string" ? {} : (out?.files ?? {});
      expect(String(files["clickhouse.sql"])).toContain("PARTITION_STRATEGY = 'hourly'");
    } finally {
      await rm(path, { recursive: true, force: true });
    }
  });
});

describe("typed columns", () => {
  test("a column with a clause chant does not read keeps its type, and its nullability and key comparison are never", () => {
    const events = table`CREATE TABLE a.events (id UInt64, k String ENCRYPTED WITH 'k1') ENGINE = MergeTree ORDER BY id`;
    const text = renderSqlTypes(new Map([["events", events]]) as Map<string, Declarable>, { projectDir: "/" });
    expect(text).toContain('id: Column<"UInt64", { ts: string; nullable: false; cmp: "UInt64" }>;');
    expect(text).toContain('k: Column<"String", { ts: string; nullable: never; cmp: never }>;');
  });
});

describe("a plan", () => {
  const declared = (ddl: string) => ({ key: "analytics.events", exportName: "events", canonical: canonicalObject(ddl) });
  const BASE = "CREATE TABLE analytics.events (ts DateTime) ENGINE = MergeTree ORDER BY ts";

  test("ClickHouse: the same clause is no change, a changed one is SQLCH290 for review, one only the server prints is a hint", () => {
    const same = diffSchemas([declared(`${BASE} PARTITION_STRATEGY = 'hourly'`)], [declared(`${BASE}\nPARTITION_STRATEGY   =  'hourly'`)]);
    expect(same.changes).toEqual([]);

    const changed = diffSchemas([declared(`${BASE} PARTITION_STRATEGY = 'hourly'`)], [declared(`${BASE} PARTITION_STRATEGY = 'daily'`)]);
    expect(changed.changes.map((c) => [c.field, c.rule, c.class])).toEqual([["unparsed.PARTITION_STRATEGY", "SQLCH290", "rebuild"]]);

    const added = diffSchemas([declared(BASE)], [declared(`${BASE} PARTITION_STRATEGY = 'hourly'`)]);
    expect(added.changes.map((c) => c.rule)).toEqual(["SQLCH290"]);

    const serverOnly = diffSchemas([declared(`${BASE} PARTITION_STRATEGY = 'hourly'`)], [declared(BASE)]);
    expect(serverOnly.changes).toEqual([]);
    expect(serverOnly.hints.join("\n")).toMatch(/PARTITION_STRATEGY .* a clause chant does not read/);

    // The rest of the object is still planned, and the refusal says why.
    const both = diffSchemas([declared(`${BASE} PARTITION_STRATEGY = 'hourly'`)], [declared(`CREATE TABLE analytics.events (ts DateTime, n UInt8) ENGINE = MergeTree ORDER BY ts PARTITION_STRATEGY = 'daily'`)]);
    expect(both.changes.map((c) => c.rule).sort()).toEqual(["SQLCH201", "SQLCH290"]);
    const after = declared(`CREATE TABLE analytics.events (ts DateTime, n UInt8) ENGINE = MergeTree ORDER BY ts PARTITION_STRATEGY = 'daily'`);
    const plan = planStatements({
      declared: [{ ...after, type: "ClickHouse::Table", ddl: "CREATE TABLE analytics.events (ts DateTime, n UInt8) ENGINE = MergeTree ORDER BY ts PARTITION_STRATEGY = 'daily'" } as never],
      changes: both.changes,
      current: new Map(),
    });
    const verdict = plan.objects[0]!;
    expect(verdict.verdict).toBe("rebuild");
    expect((verdict as { detail: string }).detail).toMatch(/^needs review, since chant does not read the clause/);
  });

  test("Postgres: a changed clause is SQLPG299, refused for review", () => {
    const o = (ddl: string): PgSchemaObject => ({ key: "t", canonical: { ...diffObject("Postgres::Table", ddl, "public"), exportName: "t" } });
    const before = o("CREATE TABLE app.t (id bigint PRIMARY KEY) STORAGE_CLASS 'cold'");
    expect(diffPgSchemas([before], [o("CREATE TABLE app.t (id bigint PRIMARY KEY) STORAGE_CLASS 'cold'")]).changes).toEqual([]);
    const d = diffPgSchemas([before], [o("CREATE TABLE app.t (id bigint PRIMARY KEY, n int) STORAGE_CLASS 'hot'")]);
    expect(d.changes.map((c) => [c.field, c.rule, c.class])).toEqual([
      ["unparsed.STORAGE_CLASS", "SQLPG299", "expand"],
      ["columns.n", "SQLPG201", "metadata"],
    ]);
    expect(d.refused.map((c) => c.rule)).toEqual(["SQLPG299"]);
  });
});
