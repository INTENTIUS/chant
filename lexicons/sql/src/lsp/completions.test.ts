import { describe, expect, test } from "vitest";
import { completions } from "./completions";

const ctx = (linePrefix: string, wordAtCursor = "") => ({
  uri: "file:///schema.ts",
  content: linePrefix,
  position: { line: 0, character: linePrefix.length },
  wordAtCursor,
  linePrefix,
});

describe("sql completions", () => {
  test("offer nothing outside a constructor position", () => {
    expect(completions(ctx("const x = 42"))).toEqual([]);
  });

  test("return a list after new", () => {
    expect(Array.isArray(completions(ctx("new ")))).toBe(true);
  });
});

const IMPORT = 'import { table, view, database } from "@intentius/chant-lexicon-sql/clickhouse";\n';

/** A source with `|` marking the cursor. */
function at(source: string) {
  const content = IMPORT + source;
  const offset = content.indexOf("|");
  const text = content.replace("|", "");
  const before = text.slice(0, offset).split("\n");
  const line = before.length - 1;
  const linePrefix = before[line]!;
  return {
    uri: "file:///schema.ts",
    content: text,
    position: { line, character: linePrefix.length },
    wordAtCursor: /\w*$/.exec(linePrefix)![0],
    linePrefix,
  };
}
const labels = (source: string) => completions(at(source)).map((i) => i.label);

describe("sql completions inside a template", () => {
  test("engines after ENGINE =", () => {
    const l = labels("export const t = table`CREATE TABLE t (a UInt8) ENGINE = Repl|`;");
    expect(l).toContain("ReplacingMergeTree");
    expect(l).not.toContain("MergeTree");
  });

  test("database engines in a database template", () => {
    const l = labels("export const d = database`CREATE DATABASE d ENGINE = |`;");
    expect(l).toContain("Atomic");
    expect(l).not.toContain("MergeTree");
  });

  test("type families where a column's type goes", () => {
    expect(labels("export const t = table`CREATE TABLE t (id UU|`;")).toContain("UUID");
    expect(labels("export const t = table`CREATE TABLE t (id UInt8, kind Low|`;")).toContain("LowCardinality");
  });

  test("types inside a wrapper", () => {
    expect(labels("export const t = table`CREATE TABLE t (kind LowCardinality(Str|`;")).toContain("String");
  });

  test("no type completion while a column name is being typed", () => {
    expect(labels("export const t = table`CREATE TABLE t (id UInt8, ki|`;")).toEqual([]);
  });

  test("codecs inside CODEC()", () => {
    expect(labels("export const t = table`CREATE TABLE t (a UInt8 CODEC(ZS|`;")).toContain("ZSTD");
  });

  test("skip index types after TYPE", () => {
    expect(labels("export const t = table`CREATE TABLE t (a UInt8, INDEX i a TYPE bloom|`;")).toContain("bloom_filter");
  });

  test("MergeTree settings after SETTINGS, with insert text", () => {
    const items = completions(at("export const t = table`CREATE TABLE t (a UInt8) ENGINE = MergeTree ORDER BY a SETTINGS index_gran|`;"));
    const item = items.find((i) => i.label === "index_granularity");
    expect(item?.insertText).toBe("index_granularity = ");
    expect(item?.detail).toMatch(/UInt64/);
  });

  test("query settings after the SELECT of a view", () => {
    const l = labels("export const v = view`CREATE VIEW v AS SELECT 1 SETTINGS max_thre|`;");
    expect(l).toContain("max_threads");
  });

  test("functions in a view's select", () => {
    expect(labels("export const v = view`CREATE VIEW v AS SELECT toStartOfH|`;")).toContain("toStartOfHour");
  });

  test("functions after DEFAULT", () => {
    expect(labels("export const t = table`CREATE TABLE t (a DateTime DEFAULT now|`;")).toContain("now");
  });
});

describe("sql completions inside ${}", () => {
  const events = 'export const events = table`CREATE TABLE events (user_id UUID, kind String) ENGINE = Log`;\n';

  test("offer the tables and views declared in the file", () => {
    const items = completions(at(events + "export const v = view`CREATE VIEW v AS SELECT 1 FROM ${|}`;"));
    expect(items.map((i) => i.label)).toEqual(["events"]);
    expect(items[0]!.documentation).toContain("user_id");
  });

  test("offer columns for an entity", () => {
    expect(labels(events + "export const v = view`CREATE VIEW v AS SELECT ${events.|}`;")).toEqual(["columns"]);
    const items = completions(at(events + "export const v = view`CREATE VIEW v AS SELECT ${events.columns.|}`;"));
    expect(items.map((i) => [i.label, i.detail])).toEqual([["user_id", "UUID"], ["kind", "String"]]);
  });
});
