import { describe, expect, it } from "vitest";
import { SqlFileParser } from "./import-parser";

const load = `create table cust_ip (c_ip text, n int);
copy cust_ip from '/tmp/usage.csv';
update cust_ip
  set n = 1;
select 1;
create index on cust_ip (c_ip);
`;

describe("sql import of a file that mixes schema and load statements", () => {
  it("refuses the statements that declare nothing, naming each, without skipUndeclarable", () => {
    expect(() => new SqlFileParser("postgres").parse(load)).toThrow(/3 statements chant cannot read[\s\S]*copy cust_ip[\s\S]*update[\s\S]*select 1/);
  });

  it("leaves them out with a warning naming the statement and its line under skipUndeclarable", () => {
    const ir = new SqlFileParser("postgres", { skipUndeclarable: true }).parse(load);
    expect(ir.resources.map((r) => (r.properties as { name: string }).name)).toEqual(["cust_ip", "cust_ip_c_ip_idx"]);
    expect(ir.warnings).toEqual(
      expect.arrayContaining([
        expect.stringContaining("COPY at line 2 declares no object: copy cust_ip from '/tmp/usage.csv'"),
        expect.stringContaining("UPDATE at line 3 declares no object: update cust_ip set n = 1"),
        expect.stringContaining("SELECT at line 5 declares no object: select 1"),
      ]),
    );
    expect(ir.warnings?.filter((w) => w.startsWith("left out (skipUndeclarable)"))).toHaveLength(3);
  });

  it("still refuses an ALTER or a CREATE it cannot read under skipUndeclarable", () => {
    expect(() => new SqlFileParser("postgres", { skipUndeclarable: true }).parse("create table t (a int);\nalter table t rename to u;")).toThrow(/ALTER TABLE other than ADD/);
  });

  it("leaves a non-CREATE ClickHouse statement out the same way", () => {
    const sql = "create table t (a UInt8) engine = MergeTree order by a;\ninsert into t values (1);";
    expect(() => new SqlFileParser("clickhouse").parse(sql)).toThrow(/not a CREATE statement/);
    const ir = new SqlFileParser("clickhouse", { skipUndeclarable: true }).parse(sql);
    expect(ir.resources).toHaveLength(1);
    expect(ir.warnings).toEqual([expect.stringContaining("INSERT at line 2 declares no object: insert into t values (1)")]);
  });
});

/** Each name below is what a Postgres 16 server gave `CREATE INDEX ON t <elements>` on `t (a int, b int, "Mixed" int, email text, j jsonb)`. */
describe("an unnamed index is named as Postgres names it", () => {
  const table = `create table t (a int, b int, "Mixed" int, email text, j jsonb, very_long_column_name_number_one int, very_long_column_name_number_two int);\n`;
  const nameOf = (elements: string): string => {
    const ir = new SqlFileParser("postgres").parse(`${table}create index on t ${elements};`);
    const index = ir.resources.find((r) => r.type.endsWith("Index"));
    return (index?.properties as { name: string }).name;
  };
  it.each([
    ["(a)", "t_a_idx"],
    ["(a, b)", "t_a_b_idx"],
    ["(a, a)", "t_a_a1_idx"],
    ['("Mixed")', "t_Mixed_idx"],
    ["(lower(email))", "t_lower_idx"],
    ["((lower(email)))", "t_lower_idx"],
    ["(lower(email) text_pattern_ops)", "t_lower_idx"],
    ["((a + b))", "t_expr_idx"],
    ["((a + b), (a - b))", "t_expr_expr1_idx"],
    ["((j->>'k'))", "t_expr_idx"],
    ["((a is null))", "t_expr_idx"],
    ["((a))", "t_a_idx"],
    ["(a desc nulls last)", "t_a_idx"],
    ["using hash (a)", "t_a_idx"],
    ["(a) where a > 0", "t_a_idx"],
    ["(a) include (b)", "t_a_b_idx"],
    ["(a, lower(email), (a+b), (b+a))", "t_a_lower_expr_expr1_idx"],
    ["(very_long_column_name_number_one, very_long_column_name_number_two)", "t_very_long_column_name_number_one_very_long_column_name_nu_idx"],
  ])("%s", (elements, name) => {
    expect(nameOf(elements)).toBe(name);
  });

  it("numbers a name the schema already has, in file order", () => {
    const ir = new SqlFileParser("postgres").parse(`${table}create index t_a_idx on t (b);\ncreate index on t (a);\ncreate index on t (a);\ncreate index on t (a, b);\ncreate index on t (a, b);`);
    expect(ir.resources.filter((r) => r.type.endsWith("Index")).map((r) => (r.properties as { name: string }).name)).toEqual(["t_a_idx", "t_a_idx1", "t_a_idx2", "t_a_b_idx", "t_a_b_idx1"]);
  });

  it("writes the name into the declaration and says it was derived", () => {
    const ir = new SqlFileParser("postgres").parse("create table t (a int);\ncreate unique index concurrently on t (a);");
    const index = ir.resources.find((r) => r.type.endsWith("Index"));
    expect((index?.properties as { ddl: string }).ddl).toMatch(/^create unique index concurrently t_a_idx on t \(a\)$/);
    expect(ir.warnings).toEqual([expect.stringContaining("index on t at line 2 has no name")]);
    expect(ir.warnings?.[0]).toContain("It is declared as t_a_idx, the name Postgres gives an unnamed index.");
  });

  it("keeps the index in the table's schema when the name is derived for a qualified table", () => {
    const ir = new SqlFileParser("postgres").parse("create table app.t (a int);\ncreate table t (a int);\ncreate index on app.t (a);\ncreate index on t (a);");
    expect(ir.resources.filter((r) => r.type.endsWith("Index")).map((r) => (r.properties as { name: string }).name)).toEqual(["t_a_idx", "t_a_idx"]);
  });

  it("refuses an index on a cast or a CASE, where it would be guessing, and says to name it", () => {
    expect(() => new SqlFileParser("postgres").parse("create table t (a int);\ncreate index on t ((a::text));")).toThrow(/an index with no name, and the name Postgres gives it depends on an expression chant does not model \(name the index in the DDL\)/);
    expect(() => new SqlFileParser("postgres").parse("create table t (a int);\ncreate index on t (coalesce(a, 0));")).toThrow(/name the index in the DDL/);
  });
});
