import * as ts from "typescript";
import { describe, expect, test } from "vitest";
import type { LintContext } from "@intentius/chant/lint/rule";
import { sqlch001 } from "./sqlch001";
import { sqlch002 } from "./sqlch002";
import { sqlch003 } from "./sqlch003";
import { sqlpg001 } from "./sqlpg001";
import { sqlpg002 } from "./sqlpg002";
import { sqlpg003 } from "./sqlpg003";

const ctx = (code: string): LintContext => ({
  sourceFile: ts.createSourceFile("schema.ts", code, ts.ScriptTarget.Latest, true),
  entities: [],
  filePath: "schema.ts",
});

const IMPORT = 'import { table, view } from "@intentius/chant-lexicon-sql/clickhouse";\n';

describe("SQLCH001: DDL that does not parse", () => {
  test("is reported at the token, as a line and column of the .ts file", () => {
    const code = `${IMPORT}export const t = table\`
  CREATE TABLE t (
    a Strin g
  ) ENGINE = Log\`;`;
    const [d, ...rest] = sqlch001.check(ctx(code));
    expect(rest).toEqual([]);
    expect(d).toMatchObject({ ruleId: "SQLCH001", severity: "error", line: 4, column: 13 });
  });

  test("a tag holding another statement is reported", () => {
    const code = `${IMPORT}export const v = table\`CREATE VIEW v AS SELECT 1\`;`;
    expect(sqlch001.check(ctx(code))[0]?.message).toMatch(/use the view tag/);
  });

  test("valid DDL with interpolations is clean", () => {
    const code = `${IMPORT}import { events } from "./events";
const name = "v";
export const v = view\`CREATE VIEW \${name} AS SELECT \${events.columns.kind} FROM \${events}\`;`;
    expect(sqlch001.check(ctx(code))).toEqual([]);
  });

  test("a tag of the same name from another module is not ours", () => {
    const code = `import { table } from "./mine";\nexport const t = table\`not sql\`;`;
    expect(sqlch001.check(ctx(code))).toEqual([]);
  });

  test("an aliased import is followed", () => {
    const code = `import { table as chTable } from "@intentius/chant-lexicon-sql/clickhouse";\nexport const t = chTable\`CREATE TABLE\`;`;
    expect(sqlch001.check(ctx(code))).toHaveLength(1);
  });
});

describe("SQLCH002: a Nullable column in a key", () => {
  test("is reported at the column in ORDER BY", () => {
    const code = `${IMPORT}export const t = table\`
  CREATE TABLE t (id UInt64, region Nullable(String))
  ENGINE = MergeTree
  ORDER BY (region, id)\`;`;
    const diags = sqlch002.check(ctx(code));
    expect(diags).toHaveLength(1);
    expect(diags[0]).toMatchObject({ ruleId: "SQLCH002", line: 5, column: 13 });
    expect(diags[0]!.message).toMatch(/"region" is Nullable/);
  });

  test("sees LowCardinality(Nullable(...)), the NULL modifier and PRIMARY KEY", () => {
    const code = `${IMPORT}export const t = table\`
  CREATE TABLE t (a LowCardinality(Nullable(String)), b UInt8 NULL, c UInt8)
  ENGINE = MergeTree ORDER BY (a, b, c) PRIMARY KEY a\`;`;
    expect(sqlch002.check(ctx(code)).map((d) => d.message.match(/"(\w+)"/)![1])).toEqual(["a", "b", "a"]);
  });

  test("a function of a nullable column, or a non-key use, is not reported", () => {
    const code = `${IMPORT}export const t = table\`
  CREATE TABLE t (a Nullable(String), id UInt64)
  ENGINE = MergeTree ORDER BY (id, ifNull(a, ''))\`;`;
    expect(sqlch002.check(ctx(code))).toEqual([]);
  });

  test("allow_nullable_key = 1 turns it off", () => {
    const code = `${IMPORT}export const t = table\`
  CREATE TABLE t (a Nullable(String)) ENGINE = MergeTree ORDER BY a SETTINGS allow_nullable_key = 1\`;`;
    expect(sqlch002.check(ctx(code))).toEqual([]);
  });
});

describe("SQLCH003: a column interpolated without .columns", () => {
  test("is reported for an entity declared in the file", () => {
    const code = `${IMPORT}export const events = table\`CREATE TABLE events (kind String) ENGINE = Log\`;
export const v = view\`CREATE VIEW v AS SELECT \${events.kind} FROM \${events}\`;`;
    const diags = sqlch003.check(ctx(code));
    expect(diags).toHaveLength(1);
    expect(diags[0]!.message).toMatch(/events\.columns\.kind/);
  });

  test("is reported for an entity imported from another project file", () => {
    const code = `${IMPORT}import { events } from "./events";
export const v = view\`CREATE VIEW v AS SELECT \${events.props} FROM \${events}\`;`;
    expect(sqlch003.check(ctx(code))).toHaveLength(1);
  });

  test("a composite's parameter object and .columns are not reported", () => {
    const code = `${IMPORT}import { events } from "./events";
const make = (props: { kind: string }) => view\`CREATE VIEW \${props.kind} AS SELECT \${events.columns.kind} FROM \${events}\`;`;
    expect(sqlch003.check(ctx(code))).toEqual([]);
  });
});

const PG = 'import { index, sequence, table, view } from "@intentius/chant-lexicon-sql/postgres";\n';

describe("SQLPG001: Postgres DDL that does not parse", () => {
  test("is reported at the token, as a line and column of the .ts file", () => {
    const code = `${PG}export const t = table\`
  CREATE TABLE t (
    a text DEFAULT 'x' CHEK (a <> '')
  )\`;`;
    const [d, ...rest] = sqlpg001.check(ctx(code));
    expect(rest).toEqual([]);
    expect(d).toMatchObject({ ruleId: "SQLPG001", severity: "error", line: 4, column: 24 });
    expect(d!.message).toMatch(/CHEK/);
  });

  test("a tag holding another statement, a second CREATE and an unnamed index are reported", () => {
    expect(sqlpg001.check(ctx(`${PG}export const i = table\`CREATE INDEX i ON t (a)\`;`))[0]?.message).toMatch(/use the index tag/);
    expect(sqlpg001.check(ctx(`${PG}export const t = table\`CREATE TABLE a (x int); CREATE TABLE b (x int)\`;`))[0]?.message).toMatch(/second statement/);
    const unnamed = sqlpg001.check(ctx(`${PG}export const i = index\`CREATE INDEX ON t (a)\`;`));
    expect(unnamed[0]).toMatchObject({ line: 2, column: 37 });
    expect(unnamed[0]!.message).toMatch(/an index needs a name/);
  });

  test("valid DDL with interpolations is clean, and ClickHouse's tags are not read as Postgres", () => {
    const code = `${PG}import { users } from "./users";
export const t = table\`CREATE TABLE \${"orders"} (id bigint PRIMARY KEY, user_id bigint REFERENCES \${users} (\${users.columns.id}))\`;`;
    expect(sqlpg001.check(ctx(code))).toEqual([]);
    const ch = 'import { table } from "@intentius/chant-lexicon-sql/clickhouse";\nexport const t = table`CREATE TABLE t (a String) ENGINE = Log`;';
    expect(sqlpg001.check(ctx(ch))).toEqual([]);
  });

  test("the package root's Postgres-only tags are Postgres's", () => {
    const code = 'import { sequence } from "@intentius/chant-lexicon-sql";\nexport const s = sequence`CREATE SEQUENCE s START WITH`;';
    expect(sqlpg001.check(ctx(code))).toHaveLength(1);
  });
});

describe("SQLPG002: a column interpolated without .columns", () => {
  test("is reported for an entity declared in the file", () => {
    const code = `${PG}export const users = table\`CREATE TABLE users (kind text)\`;
export const v = view\`CREATE VIEW v AS SELECT \${users.kind} FROM \${users}\`;`;
    const diags = sqlpg002.check(ctx(code));
    expect(diags).toHaveLength(1);
    expect(diags[0]!.message).toMatch(/users\.columns\.kind/);
  });
});

describe("SQLPG003: an object named in a regclass string", () => {
  test("nextval('...') and '...'::regclass are reported at the string", () => {
    const code = `${PG}export const t = table\`CREATE TABLE t (
    a bigint DEFAULT nextval('app.seq'),
    b regclass DEFAULT 'app.t'::regclass
  )\`;`;
    const diags = sqlpg003.check(ctx(code));
    expect(diags.map((d) => [d.line, d.column])).toEqual([[3, 30], [4, 24]]);
    expect(diags[0]!.message).toMatch(/nextval\(\$\{\.\.\.\}\)/);
    expect(diags[0]!.severity).toBe("warning");
  });

  test("an interpolated sequence is clean", () => {
    const code = `${PG}import { seq } from "./seq";
export const t = table\`CREATE TABLE t (a bigint DEFAULT nextval(\${seq}))\`;`;
    expect(sqlpg003.check(ctx(code))).toEqual([]);
  });
});
